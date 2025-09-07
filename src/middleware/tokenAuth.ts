import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { getCurrentTenantId } from './tenant';

/**
 * Interface para requisições autenticadas
 */
export interface AuthenticatedRequest extends Request {
  tokenType?: 'admin' | 'webhook';
  tokenValid?: boolean;
}

/**
 * Obter token do cabeçalho da requisição
 */
function extractToken(req: Request, headerName: string): string | null {
  const token = req.headers[headerName];
  
  if (typeof token === 'string') {
    return token.trim();
  }
  
  if (Array.isArray(token) && token.length > 0) {
    return token[0].trim();
  }
  
  return null;
}

/**
 * Validar token admin
 */
function validateAdminToken(token: string): boolean {
  const validToken = process.env.ADMIN_TOKEN;
  
  if (!validToken) {
    logger.error('ADMIN_TOKEN not configured');
    return false;
  }
  
  // Comparação segura contra timing attacks
  if (token.length !== validToken.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ validToken.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Validar token de webhook
 */
function validateWebhookToken(token: string): boolean {
  const validToken = process.env.EVOLUTION_WEBHOOK_TOKEN;
  
  if (!validToken) {
    logger.error('EVOLUTION_WEBHOOK_TOKEN not configured');
    return false;
  }
  
  // Comparação segura contra timing attacks
  if (token.length !== validToken.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ validToken.charCodeAt(i);
  }
  
  return result === 0;
}

/**
 * Middleware de autenticação para endpoints admin (suporta X-Admin-Token e Bearer)
 */
export function adminAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // Tentar X-Admin-Token primeiro
  let token = extractToken(req, 'x-admin-token');
  
  // Se não encontrou, tentar Bearer token
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7); // Remove 'Bearer '
    }
  }
  
  const tenantId = getCurrentTenantId(req) || 'default';
  
  if (!token) {
    logger.warn('Admin access attempt without token', {
      tenantId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      method: req.method
    });
    
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Admin token required (X-Admin-Token header or Bearer authorization)',
      code: 'MISSING_ADMIN_TOKEN'
    });
    return;
  }
  
  if (!validateAdminToken(token)) {
    logger.warn('Admin access attempt with invalid token', {
      tenantId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      method: req.method,
      tokenLength: token.length
    });
    
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid admin token',
      code: 'INVALID_ADMIN_TOKEN'
    });
    return;
  }
  
  // Marcar requisição como autenticada
  req.tokenType = 'admin';
  req.tokenValid = true;
  
  logger.info('Admin access granted', {
    tenantId,
    ip: req.ip,
    path: req.path,
    method: req.method
  });
  
  next();
}

/**
 * Middleware de autenticação para webhooks
 */
export function webhookAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req, 'x-webhook-token');
  const tenantId = getCurrentTenantId(req) || 'default';
  
  if (!token) {
    logger.warn('Webhook access attempt without token', {
      tenantId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      method: req.method
    });
    
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Webhook token required',
      code: 'MISSING_WEBHOOK_TOKEN'
    });
    return;
  }
  
  if (!validateWebhookToken(token)) {
    logger.warn('Webhook access attempt with invalid token', {
      tenantId,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      method: req.method,
      tokenLength: token.length
    });
    
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid webhook token',
      code: 'INVALID_WEBHOOK_TOKEN'
    });
    return;
  }
  
  // Marcar requisição como autenticada
  req.tokenType = 'webhook';
  req.tokenValid = true;
  
  logger.info('Webhook access granted', {
    tenantId,
    ip: req.ip,
    path: req.path,
    method: req.method
  });
  
  next();
}

/**
 * Middleware de autenticação flexível (admin OU webhook)
 */
export function flexibleAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const adminToken = extractToken(req, 'x-admin-token');
  const webhookToken = extractToken(req, 'x-webhook-token');
  const tenantId = getCurrentTenantId(req) || 'default';
  
  // Tentar autenticação admin primeiro
  if (adminToken && validateAdminToken(adminToken)) {
    req.tokenType = 'admin';
    req.tokenValid = true;
    
    logger.info('Flexible auth: Admin access granted', {
      tenantId,
      ip: req.ip,
      path: req.path,
      method: req.method
    });
    
    return next();
  }
  
  // Tentar autenticação webhook
  if (webhookToken && validateWebhookToken(webhookToken)) {
    req.tokenType = 'webhook';
    req.tokenValid = true;
    
    logger.info('Flexible auth: Webhook access granted', {
      tenantId,
      ip: req.ip,
      path: req.path,
      method: req.method
    });
    
    return next();
  }
  
  // Nenhuma autenticação válida
  logger.warn('Flexible auth: Access denied', {
    tenantId,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    path: req.path,
    method: req.method,
    hasAdminToken: !!adminToken,
    hasWebhookToken: !!webhookToken
  });
  
  res.status(401).json({
    error: 'Unauthorized',
    message: 'Valid admin or webhook token required',
    code: 'AUTHENTICATION_REQUIRED'
  });
  return;
}

/**
 * Middleware para verificar se o token é especificamente admin
 */
export function requireAdminToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.tokenType !== 'admin' || !req.tokenValid) {
    const tenantId = getCurrentTenantId(req) || 'default';
    
    logger.warn('Admin-only access denied', {
      tenantId,
      ip: req.ip,
      path: req.path,
      method: req.method,
      tokenType: req.tokenType
    });
    
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin token required for this operation',
      code: 'ADMIN_TOKEN_REQUIRED'
    });
    return;
  }
  
  next();
}

/**
 * Middleware para verificar se o token é especificamente webhook
 */
export function requireWebhookToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.tokenType !== 'webhook' || !req.tokenValid) {
    const tenantId = getCurrentTenantId(req) || 'default';
    
    logger.warn('Webhook-only access denied', {
      tenantId,
      ip: req.ip,
      path: req.path,
      method: req.method,
      tokenType: req.tokenType
    });
    
    res.status(403).json({
      error: 'Forbidden',
      message: 'Webhook token required for this operation',
      code: 'WEBHOOK_TOKEN_REQUIRED'
    });
    return;
  }
  
  next();
}

/**
 * Middleware para validar configuração de tokens
 */
export function validateTokenConfiguration(req: Request, res: Response, next: NextFunction): void {
  const errors: string[] = [];
  
  if (!process.env.ADMIN_TOKEN) {
    errors.push('ADMIN_TOKEN not configured');
  } else if (process.env.ADMIN_TOKEN.length < 32) {
    errors.push('ADMIN_TOKEN too short (minimum 32 characters)');
  }
  
  if (!process.env.EVOLUTION_WEBHOOK_TOKEN) {
    errors.push('EVOLUTION_WEBHOOK_TOKEN not configured');
  } else if (process.env.EVOLUTION_WEBHOOK_TOKEN.length < 32) {
    errors.push('EVOLUTION_WEBHOOK_TOKEN too short (minimum 32 characters)');
  }
  
  if (errors.length > 0) {
    logger.error('Token configuration validation failed', { errors });
    
    res.status(500).json({
      error: 'Server configuration error',
      message: 'Authentication tokens not properly configured',
      code: 'TOKEN_CONFIG_ERROR'
    });
    return;
  }
  
  next();
}

/**
 * Utilitário para gerar tokens seguros
 */
export function generateSecureToken(length: number = 64): string {
  const crypto = require('crypto');
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Utilitário para verificar força do token
 */
export function validateTokenStrength(token: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  if (token.length < 32) {
    issues.push('Token too short (minimum 32 characters)');
  }
  
  if (token.length > 256) {
    issues.push('Token too long (maximum 256 characters)');
  }
  
  if (!/^[a-zA-Z0-9+/=_-]+$/.test(token)) {
    issues.push('Token contains invalid characters');
  }
  
  // Verificar se não é um token óbvio/fraco
  const weakPatterns = [
    /^(admin|password|secret|token|key|test|dev|prod|staging)$/i,
    /^(123|abc|qwe|aaa|000)/i,
    /^(..)\1{5,}$/ // Padrões repetitivos
  ];
  
  for (const pattern of weakPatterns) {
    if (pattern.test(token)) {
      issues.push('Token appears to be weak or predictable');
      break;
    }
  }
  
  return {
    valid: issues.length === 0,
    issues
  };
}