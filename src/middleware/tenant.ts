import { Request, Response, NextFunction } from 'express';
import { pool } from '../infra/db';
import logger from '../utils/logger';

// Extend Express Request to include tenant_id
declare global {
  namespace Express {
    interface Request {
      tenant_id?: string;
    }
  }
}

/**
 * Middleware para definir o tenant_id no contexto da sessão do banco de dados.
 * 
 * Estratégias de identificação do tenant (em ordem de prioridade):
 * 1. Header x-tenant-id (para admin/API calls)
 * 2. Query parameter tenant_id (para webhooks/callbacks)
 * 3. Tenant padrão 'default' (fallback)
 * 
 * O tenant_id é validado contra a tabela tenants e definido como
 * app.tenant_id na sessão PostgreSQL para uso com RLS.
 */
export const tenantMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // 1. Tentar obter tenant_id do header
    let tenantId = req.headers['x-tenant-id'] as string;
    
    // 2. Se não encontrado no header, tentar query parameter
    if (!tenantId) {
      tenantId = req.query.tenant_id as string;
    }
    
    // 3. Fallback para tenant padrão
    if (!tenantId) {
      tenantId = 'default';
    }
    
    // Validar se o tenant existe na base de dados
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT id FROM tenants WHERE id = $1 AND active = true',
        [tenantId]
      );
      
      if (result.rows.length === 0) {
        logger.warn('Invalid or inactive tenant_id provided', {
          tenant_id: tenantId,
          ip: req.ip,
          user_agent: req.get('User-Agent'),
          path: req.path
        });
        
        // Fallback para tenant default se o tenant solicitado não existir
        tenantId = 'default';
        
        // Verificar se o tenant default existe
        const defaultResult = await client.query(
          'SELECT id FROM tenants WHERE id = $1 AND active = true',
          ['default']
        );
        
        if (defaultResult.rows.length === 0) {
          logger.error('Default tenant not found or inactive');
          res.status(500).json({ error: 'Tenant configuration error' });
          return;
        }
      }
      
      // Definir app.tenant_id na sessão PostgreSQL para RLS
      await client.query('SELECT set_config($1, $2, true)', [
        'app.tenant_id',
        tenantId
      ]);
      
      // Adicionar tenant_id ao objeto request para uso posterior
      req.tenant_id = tenantId;
      
      logger.debug('Tenant context set', {
        tenant_id: tenantId,
        path: req.path,
        method: req.method
      });
      
    } finally {
      client.release();
    }
    
    next();
  } catch (error) {
    logger.error('Error in tenant middleware', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      path: req.path,
      method: req.method
    });
    
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Middleware para validar que o tenant_id foi definido corretamente.
 * Deve ser usado após o tenantMiddleware em rotas que requerem isolamento.
 */
export const requireTenant = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.tenant_id) {
    logger.error('Tenant context not set', {
      path: req.path,
      method: req.method,
      ip: req.ip
    });
    
    res.status(500).json({ error: 'Tenant context not available' });
    return;
  }
  
  next();
};

/**
 * Utilitário para obter o tenant_id atual da requisição
 */
export const getCurrentTenantId = (req: Request): string | undefined => {
  return req.tenant_id;
};