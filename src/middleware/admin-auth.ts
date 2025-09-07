import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import logger from '../utils/logger';

interface AdminAuthConfig {
  token: string;
  ip_allowlist: {
    enabled: boolean;
    cidrs: string[];
  };
  rate_limit?: {
    max_requests: number;
    window_minutes: number;
  };
}

interface AuthAttempt {
  ip: string;
  timestamp: number;
  success: boolean;
  userAgent?: string;
}

/**
 * Middleware avançado de autenticação admin com bearer token e IP allowlist
 */
export class AdminAuthentication {
  private config: AdminAuthConfig;
  private authAttempts: AuthAttempt[] = [];
  private blockedIPs = new Set<string>();
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutos

  constructor(config: AdminAuthConfig) {
    this.config = config;
    
    // Limpeza periódica de tentativas antigas
    setInterval(() => this.cleanupOldAttempts(), 60000); // 1 minuto
  }

  /**
   * Middleware principal de autenticação
   */
  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const clientIP = this.getClientIP(req);
        
        // Verificar se IP está bloqueado
        if (this.isIPBlocked(clientIP)) {
          this.logAuthAttempt(clientIP, false, 'IP blocked', req.get('User-Agent'));
          return res.status(429).json({
            error: 'IP temporarily blocked due to multiple failed attempts',
            retryAfter: this.BLOCK_DURATION_MS / 1000
          });
        }

        // Verificar IP allowlist se habilitado
        if (this.config.ip_allowlist.enabled && !this.isIPAllowed(clientIP)) {
          this.logAuthAttempt(clientIP, false, 'IP not in allowlist', req.get('User-Agent'));
          return res.status(403).json({
            error: 'Access denied: IP not in allowlist'
          });
        }

        // Verificar bearer token
        const authResult = this.verifyBearerToken(req);
        if (!authResult.valid) {
          this.logAuthAttempt(clientIP, false, authResult.reason, req.get('User-Agent'));
          this.recordFailedAttempt(clientIP, req.get('User-Agent'));
          
          return res.status(401).json({
            error: authResult.reason
          });
        }

        // Autenticação bem-sucedida
        this.logAuthAttempt(clientIP, true, 'Bearer token valid', req.get('User-Agent'));
        this.recordSuccessfulAttempt(clientIP, req.get('User-Agent'));
        
        // Adicionar informações de autenticação ao request
        (req as any).auth = {
          type: 'bearer',
          ip: clientIP,
          timestamp: Date.now()
        };

        next();
      } catch (error) {
        logger.error('Admin authentication error', {
          error: error instanceof Error ? error.message : 'Unknown error',
          ip: req.ip,
          path: req.path
        });
        
        return res.status(500).json({
          error: 'Internal authentication error'
        });
      }
    };
  }

  /**
   * Obtém o IP real do cliente considerando proxies
   */
  private getClientIP(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'] as string;
    const realIP = req.headers['x-real-ip'] as string;
    
    if (forwarded) {
      // Pegar o primeiro IP da lista (cliente original)
      return forwarded.split(',')[0].trim();
    }
    
    if (realIP) {
      return realIP;
    }
    
    return req.ip || req.connection.remoteAddress || 'unknown';
  }

  /**
   * Verifica se o IP está na allowlist
   */
  private isIPAllowed(ip: string): boolean {
    if (!this.config.ip_allowlist.enabled || this.config.ip_allowlist.cidrs.length === 0) {
      return true;
    }

    return this.config.ip_allowlist.cidrs.some(cidr => this.isIPInCIDR(ip, cidr));
  }

  /**
   * Verifica se IP está em um CIDR
   */
  private isIPInCIDR(ip: string, cidr: string): boolean {
    if (!cidr.includes('/')) {
      // IP exato
      return ip === cidr;
    }

    const [network, prefixLength] = cidr.split('/');
    const prefix = parseInt(prefixLength);
    
    // Implementação básica para IPv4
    if (this.isIPv4(ip) && this.isIPv4(network)) {
      return this.isIPv4InCIDR(ip, network, prefix);
    }
    
    // Para IPv6 ou casos complexos, usar biblioteca externa em produção
    return false;
  }

  /**
   * Verifica se é IPv4
   */
  private isIPv4(ip: string): boolean {
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    return ipv4Regex.test(ip);
  }

  /**
   * Verifica se IPv4 está em CIDR
   */
  private isIPv4InCIDR(ip: string, network: string, prefix: number): boolean {
    const ipParts = ip.split('.').map(Number);
    const networkParts = network.split('.').map(Number);
    
    const ipInt = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
    const networkInt = (networkParts[0] << 24) + (networkParts[1] << 16) + (networkParts[2] << 8) + networkParts[3];
    
    const mask = (-1 << (32 - prefix)) >>> 0;
    
    return (ipInt & mask) === (networkInt & mask);
  }

  /**
   * Verifica bearer token
   */
  private verifyBearerToken(req: Request): { valid: boolean; reason: string } {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return { valid: false, reason: 'Missing Authorization header' };
    }

    if (!authHeader.startsWith('Bearer ')) {
      return { valid: false, reason: 'Invalid Authorization header format' };
    }

    const token = authHeader.substring(7); // Remove 'Bearer '
    
    if (!token) {
      return { valid: false, reason: 'Missing bearer token' };
    }

    if (!this.config.token) {
      return { valid: false, reason: 'Server configuration error: no admin token configured' };
    }

    // Comparação segura contra timing attacks
    if (!this.safeCompare(token, this.config.token)) {
      return { valid: false, reason: 'Invalid bearer token' };
    }

    return { valid: true, reason: 'Valid' };
  }

  /**
   * Comparação segura contra timing attacks
   */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }

  /**
   * Verifica se IP está bloqueado
   */
  private isIPBlocked(ip: string): boolean {
    return this.blockedIPs.has(ip);
  }

  /**
   * Registra tentativa de autenticação falhada
   */
  private recordFailedAttempt(ip: string, userAgent?: string): void {
    const now = Date.now();
    
    this.authAttempts.push({
      ip,
      timestamp: now,
      success: false,
      userAgent
    });

    // Contar falhas recentes deste IP
    const recentFailures = this.authAttempts.filter(
      attempt => 
        attempt.ip === ip && 
        !attempt.success && 
        (now - attempt.timestamp) < this.BLOCK_DURATION_MS
    ).length;

    // Bloquear IP se muitas falhas
    if (recentFailures >= this.MAX_FAILED_ATTEMPTS) {
      this.blockedIPs.add(ip);
      
      logger.warn('IP blocked due to multiple failed auth attempts', {
        ip,
        failedAttempts: recentFailures,
        blockDuration: this.BLOCK_DURATION_MS / 1000
      });
      
      // Remover bloqueio após duração especificada
      setTimeout(() => {
        this.blockedIPs.delete(ip);
        logger.info('IP unblocked', { ip });
      }, this.BLOCK_DURATION_MS);
    }
  }

  /**
   * Registra tentativa de autenticação bem-sucedida
   */
  private recordSuccessfulAttempt(ip: string, userAgent?: string): void {
    this.authAttempts.push({
      ip,
      timestamp: Date.now(),
      success: true,
      userAgent
    });
  }

  /**
   * Log de tentativa de autenticação
   */
  private logAuthAttempt(ip: string, success: boolean, reason: string, userAgent?: string): void {
    const logData = {
      ip,
      success,
      reason,
      userAgent,
      timestamp: new Date().toISOString()
    };

    if (success) {
      logger.info('Admin authentication successful', logData);
    } else {
      logger.warn('Admin authentication failed', logData);
    }
  }

  /**
   * Limpa tentativas antigas
   */
  private cleanupOldAttempts(): void {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 horas
    this.authAttempts = this.authAttempts.filter(attempt => attempt.timestamp > cutoff);
  }

  /**
   * Obtém estatísticas de autenticação
   */
  public getStats(): any {
    const now = Date.now();
    const last24h = now - (24 * 60 * 60 * 1000);
    const last1h = now - (60 * 60 * 1000);
    
    const recent24h = this.authAttempts.filter(a => a.timestamp > last24h);
    const recent1h = this.authAttempts.filter(a => a.timestamp > last1h);
    
    return {
      blockedIPs: Array.from(this.blockedIPs),
      stats24h: {
        total: recent24h.length,
        successful: recent24h.filter(a => a.success).length,
        failed: recent24h.filter(a => !a.success).length
      },
      stats1h: {
        total: recent1h.length,
        successful: recent1h.filter(a => a.success).length,
        failed: recent1h.filter(a => !a.success).length
      }
    };
  }
}

/**
 * Factory function para criar middleware de autenticação admin
 */
export function createAdminAuth(config: Partial<AdminAuthConfig> = {}) {
  const defaultConfig: AdminAuthConfig = {
    token: process.env.ADMIN_TOKEN || '',
    ip_allowlist: {
      enabled: !!process.env.ADMIN_IP_ALLOWLIST,
      cidrs: process.env.ADMIN_IP_ALLOWLIST?.split(',').map(ip => ip.trim()) || []
    }
  };

  const finalConfig = { ...defaultConfig, ...config };
  
  if (!finalConfig.token) {
    throw new Error('Admin token not configured');
  }

  const adminAuth = new AdminAuthentication(finalConfig);
  return adminAuth.middleware();
}

/**
 * Middleware pré-configurado para autenticação admin
 */
export const adminAuth = createAdminAuth();

/**
 * Middleware para endpoints que requerem autenticação admin
 */
export function requireAdminAuth() {
  return adminAuth;
}

/**
 * Middleware para verificar apenas o token (sem IP allowlist)
 */
export const adminTokenOnly = createAdminAuth({
  ip_allowlist: { enabled: false, cidrs: [] }
});