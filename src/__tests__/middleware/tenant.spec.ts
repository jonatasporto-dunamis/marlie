import { Request, Response, NextFunction } from 'express';
import { tenantMiddleware, requireTenant, getCurrentTenantId } from '../../middleware/tenant';
import { pool } from '../../infra/db';
import logger from '../../utils/logger';

// Mock dependencies
jest.mock('../../infra/db');
jest.mock('../../utils/logger');

const mockPool = pool as jest.Mocked<typeof pool>;
const mockLogger = logger as jest.Mocked<typeof logger>;

describe('Tenant Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let mockClient: any;

  beforeEach(() => {
    mockReq = {
      headers: {},
      query: {},
      ip: '127.0.0.1',
      path: '/test',
      method: 'GET',
      get: jest.fn().mockReturnValue('test-agent')
    };
    
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    mockNext = jest.fn();
    
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    } as any;
    
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);
    
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('tenantMiddleware', () => {
    it('should use tenant_id from x-tenant-id header when provided', async () => {
      mockReq.headers = { 'x-tenant-id': 'company-123' };
      
      // Mock tenant exists
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'company-123' }] }) // tenant validation
        .mockResolvedValueOnce({}); // set_config
      
      await tenantMiddleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT id FROM tenants WHERE id = $1 AND active = true',
        ['company-123']
      );
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT set_config($1, $2, true)',
        ['app.tenant_id', 'company-123']
      );
      
      expect(mockReq.tenant_id).toBe('company-123');
      expect(mockNext).toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should use tenant_id from query parameter when header not provided', async () => {
      mockReq.query = { tenant_id: 'company-456' };
      
      // Mock tenant exists
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'company-456' }] }) // tenant validation
        .mockResolvedValueOnce({}); // set_config
      
      await tenantMiddleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT id FROM tenants WHERE id = $1 AND active = true',
        ['company-456']
      );
      
      expect(mockReq.tenant_id).toBe('company-456');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should fallback to default tenant when no tenant_id provided', async () => {
      // Mock default tenant exists
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'default' }] }) // tenant validation
        .mockResolvedValueOnce({}); // set_config
      
      await tenantMiddleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT id FROM tenants WHERE id = $1 AND active = true',
        ['default']
      );
      
      expect(mockReq.tenant_id).toBe('default');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should fallback to default when invalid tenant_id provided', async () => {
      mockReq.headers = { 'x-tenant-id': 'invalid-tenant' };
      
      // Mock invalid tenant, then valid default
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // invalid tenant
        .mockResolvedValueOnce({ rows: [{ id: 'default' }] }) // default tenant validation
        .mockResolvedValueOnce({}); // set_config
      
      await tenantMiddleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Invalid or inactive tenant_id provided',
        expect.objectContaining({
          tenant_id: 'invalid-tenant',
          ip: '127.0.0.1',
          path: '/test'
        })
      );
      
      expect(mockReq.tenant_id).toBe('default');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 500 when default tenant does not exist', async () => {
      mockReq.headers = { 'x-tenant-id': 'invalid-tenant' };
      
      // Mock both invalid tenant and missing default
      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // invalid tenant
        .mockResolvedValueOnce({ rows: [] }); // default tenant not found
      
      await tenantMiddleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockLogger.error).toHaveBeenCalledWith('Default tenant not found or inactive');
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Tenant configuration error' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      const dbError = new Error('Database connection failed');
      (mockPool.connect as jest.Mock).mockRejectedValue(dbError);
      
      await tenantMiddleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error in tenant middleware',
        expect.objectContaining({
          error: 'Database connection failed',
          path: '/test',
          method: 'GET'
        })
      );
      
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Internal server error' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should release database connection even on error', async () => {
      const dbError = new Error('Query failed');
      mockClient.query.mockRejectedValue(dbError);
      
      await tenantMiddleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('requireTenant', () => {
    it('should call next when tenant_id is set', () => {
      mockReq.tenant_id = 'company-123';
      
      requireTenant(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 500 when tenant_id is not set', () => {
      requireTenant(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Tenant context not set',
        expect.objectContaining({
          path: '/test',
          method: 'GET',
          ip: '127.0.0.1'
        })
      );
      
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Tenant context not available' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentTenantId', () => {
    it('should return tenant_id when set', () => {
      mockReq.tenant_id = 'company-123';
      
      const result = getCurrentTenantId(mockReq as Request);
      
      expect(result).toBe('company-123');
    });

    it('should return undefined when tenant_id is not set', () => {
      const result = getCurrentTenantId(mockReq as Request);
      
      expect(result).toBeUndefined();
    });
  });
});