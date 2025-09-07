/**
 * Serviço de Seeds para Ambiente de Staging
 * 
 * Responsável por:
 * - Carregar dados de teste (clientes, serviços, profissionais, agendamentos)
 * - Resetar dados de teste
 * - Manter consistência referencial
 * - Suporte a multi-tenancy
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import { MarlieQualityConfig } from '../modules/marlie-quality';

/**
 * Interface para dados de seed
 */
export interface SeedData {
  clients: Array<{
    id: string;
    tenant_id: string;
    name: string;
    phone: string;
    email?: string;
    created_at: Date;
  }>;
  services: Array<{
    id: string;
    tenant_id: string;
    name: string;
    description: string;
    duration_minutes: number;
    price: number;
    active: boolean;
    created_at: Date;
  }>;
  professionals: Array<{
    id: string;
    tenant_id: string;
    name: string;
    email: string;
    phone: string;
    specialties: string[];
    active: boolean;
    created_at: Date;
  }>;
  appointments: Array<{
    id: string;
    tenant_id: string;
    client_id: string;
    professional_id: string;
    service_id: string;
    scheduled_at: Date;
    status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled';
    notes?: string;
    created_at: Date;
  }>;
}

/**
 * Resultado da operação de seed
 */
export interface SeedResult {
  success: boolean;
  inserted: number;
  details: {
    clients: number;
    services: number;
    professionals: number;
    appointments: number;
  };
  errors?: string[];
}

/**
 * Resultado da operação de reset
 */
export interface ResetResult {
  success: boolean;
  cleared: number;
  details: {
    appointments: number;
    clients: number;
    services: number;
    professionals: number;
  };
  errors?: string[];
}

/**
 * Serviço de Seeds
 */
export class SeedService {
  private pgPool: Pool;
  private config: MarlieQualityConfig;
  private defaultTenantId: string = 'seed-tenant-001';

  constructor(pgPool: Pool, config: MarlieQualityConfig) {
    this.pgPool = pgPool;
    this.config = config;
  }

  /**
   * Inicializa o serviço
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing SeedService...');
      
      // Verificar se as tabelas existem
      await this.verifyTables();
      
      logger.info('SeedService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize SeedService:', error);
      throw error;
    }
  }

  /**
   * Carrega dados básicos de teste
   */
  async loadBasics(rows: number = 3): Promise<SeedResult> {
    const client = await this.pgPool.connect();
    
    try {
      await client.query('BEGIN');
      
      logger.info(`Loading basic seed data with ${rows} rows`);
      
      const seedData = this.generateSeedData(rows);
      const result: SeedResult = {
        success: false,
        inserted: 0,
        details: {
          clients: 0,
          services: 0,
          professionals: 0,
          appointments: 0
        },
        errors: []
      };

      // Inserir clientes
      try {
        const clientsInserted = await this.insertClients(client, seedData.clients);
        result.details.clients = clientsInserted;
        result.inserted += clientsInserted;
        logger.info(`Inserted ${clientsInserted} clients`);
      } catch (error) {
        result.errors?.push(`Failed to insert clients: ${(error as Error).message}`);
      }

      // Inserir serviços
      try {
        const servicesInserted = await this.insertServices(client, seedData.services);
        result.details.services = servicesInserted;
        result.inserted += servicesInserted;
        logger.info(`Inserted ${servicesInserted} services`);
      } catch (error) {
        result.errors?.push(`Failed to insert services: ${(error as Error).message}`);
      }

      // Inserir profissionais
      try {
        const professionalsInserted = await this.insertProfessionals(client, seedData.professionals);
        result.details.professionals = professionalsInserted;
        result.inserted += professionalsInserted;
        logger.info(`Inserted ${professionalsInserted} professionals`);
      } catch (error) {
        result.errors?.push(`Failed to insert professionals: ${(error as Error).message}`);
      }

      // Inserir agendamentos
      try {
        const appointmentsInserted = await this.insertAppointments(client, seedData.appointments);
        result.details.appointments = appointmentsInserted;
        result.inserted += appointmentsInserted;
        logger.info(`Inserted ${appointmentsInserted} appointments`);
      } catch (error) {
        result.errors?.push(`Failed to insert appointments: ${(error as Error).message}`);
      }

      if (result.errors && result.errors.length > 0) {
        await client.query('ROLLBACK');
        result.success = false;
        logger.error('Seed operation failed with errors:', result.errors);
      } else {
        await client.query('COMMIT');
        result.success = true;
        logger.info('Seed operation completed successfully', {
          inserted: result.inserted,
          details: result.details
        });
      }

      return result;

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to load basic seeds:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reseta dados de teste
   */
  async reset(): Promise<ResetResult> {
    const client = await this.pgPool.connect();
    
    try {
      await client.query('BEGIN');
      
      logger.info('Resetting test data...');
      
      const result: ResetResult = {
        success: false,
        cleared: 0,
        details: {
          appointments: 0,
          clients: 0,
          services: 0,
          professionals: 0
        },
        errors: []
      };

      // Deletar em ordem para manter integridade referencial
      // 1. Agendamentos
      try {
        const appointmentsResult = await client.query(
          'DELETE FROM appointments WHERE tenant_id = $1',
          [this.defaultTenantId]
        );
        result.details.appointments = appointmentsResult.rowCount || 0;
        result.cleared += result.details.appointments;
        logger.info(`Cleared ${result.details.appointments} appointments`);
      } catch (error) {
        result.errors?.push(`Failed to clear appointments: ${(error as Error).message}`);
      }

      // 2. Clientes
      try {
        const clientsResult = await client.query(
          'DELETE FROM clients WHERE tenant_id = $1',
          [this.defaultTenantId]
        );
        result.details.clients = clientsResult.rowCount || 0;
        result.cleared += result.details.clients;
        logger.info(`Cleared ${result.details.clients} clients`);
      } catch (error) {
        result.errors?.push(`Failed to clear clients: ${(error as Error).message}`);
      }

      // 3. Serviços
      try {
        const servicesResult = await client.query(
          'DELETE FROM services WHERE tenant_id = $1',
          [this.defaultTenantId]
        );
        result.details.services = servicesResult.rowCount || 0;
        result.cleared += result.details.services;
        logger.info(`Cleared ${result.details.services} services`);
      } catch (error) {
        result.errors?.push(`Failed to clear services: ${(error as Error).message}`);
      }

      // 4. Profissionais
      try {
        const professionalsResult = await client.query(
          'DELETE FROM professionals WHERE tenant_id = $1',
          [this.defaultTenantId]
        );
        result.details.professionals = professionalsResult.rowCount || 0;
        result.cleared += result.details.professionals;
        logger.info(`Cleared ${result.details.professionals} professionals`);
      } catch (error) {
        result.errors?.push(`Failed to clear professionals: ${(error as Error).message}`);
      }

      if (result.errors && result.errors.length > 0) {
        await client.query('ROLLBACK');
        result.success = false;
        logger.error('Reset operation failed with errors:', result.errors);
      } else {
        await client.query('COMMIT');
        result.success = true;
        logger.info('Reset operation completed successfully', {
          cleared: result.cleared,
          details: result.details
        });
      }

      return result;

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to reset seeds:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Gera dados de seed
   */
  private generateSeedData(rows: number): SeedData {
    const now = new Date();
    const clients = [];
    const services = [];
    const professionals = [];
    const appointments = [];

    // Gerar clientes
    for (let i = 1; i <= rows; i++) {
      clients.push({
        id: `seed-client-${i.toString().padStart(3, '0')}`,
        tenant_id: this.defaultTenantId,
        name: `Cliente Teste ${i}`,
        phone: `+5571${(90000000 + i).toString()}`,
        email: `cliente${i}@teste.com`,
        created_at: new Date(now.getTime() - (i * 24 * 60 * 60 * 1000))
      });
    }

    // Gerar serviços
    const serviceTypes = [
      { name: 'Corte de Cabelo', duration: 30, price: 25.00 },
      { name: 'Manicure', duration: 45, price: 20.00 },
      { name: 'Pedicure', duration: 60, price: 30.00 },
      { name: 'Escova', duration: 40, price: 35.00 },
      { name: 'Coloração', duration: 120, price: 80.00 }
    ];

    for (let i = 1; i <= Math.min(rows, serviceTypes.length); i++) {
      const serviceType = serviceTypes[i - 1];
      services.push({
        id: `seed-service-${i.toString().padStart(3, '0')}`,
        tenant_id: this.defaultTenantId,
        name: serviceType.name,
        description: `Serviço de ${serviceType.name.toLowerCase()} para teste`,
        duration_minutes: serviceType.duration,
        price: serviceType.price,
        active: true,
        created_at: new Date(now.getTime() - (i * 12 * 60 * 60 * 1000))
      });
    }

    // Gerar profissionais
    for (let i = 1; i <= rows; i++) {
      professionals.push({
        id: `seed-professional-${i.toString().padStart(3, '0')}`,
        tenant_id: this.defaultTenantId,
        name: `Profissional ${i}`,
        email: `profissional${i}@teste.com`,
        phone: `+5571${(80000000 + i).toString()}`,
        specialties: services.slice(0, Math.min(2, services.length)).map(s => s.name),
        active: true,
        created_at: new Date(now.getTime() - (i * 6 * 60 * 60 * 1000))
      });
    }

    // Gerar agendamentos
    for (let i = 1; i <= rows; i++) {
      const client = clients[Math.floor(Math.random() * clients.length)];
      const professional = professionals[Math.floor(Math.random() * professionals.length)];
      const service = services[Math.floor(Math.random() * services.length)];
      
      const scheduledAt = new Date(now.getTime() + (i * 24 * 60 * 60 * 1000));
      const statuses: Array<'scheduled' | 'confirmed' | 'completed' | 'cancelled'> = 
        ['scheduled', 'confirmed', 'completed'];
      
      appointments.push({
        id: `seed-appointment-${i.toString().padStart(3, '0')}`,
        tenant_id: this.defaultTenantId,
        client_id: client.id,
        professional_id: professional.id,
        service_id: service.id,
        scheduled_at: scheduledAt,
        status: statuses[Math.floor(Math.random() * statuses.length)],
        notes: `Agendamento de teste ${i}`,
        created_at: new Date(now.getTime() - (i * 2 * 60 * 60 * 1000))
      });
    }

    return { clients, services, professionals, appointments };
  }

  /**
   * Insere clientes
   */
  private async insertClients(client: PoolClient, clients: SeedData['clients']): Promise<number> {
    let inserted = 0;
    
    for (const clientData of clients) {
      try {
        await client.query(
          `INSERT INTO clients (id, tenant_id, name, phone, email, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (id) DO NOTHING`,
          [clientData.id, clientData.tenant_id, clientData.name, 
           clientData.phone, clientData.email, clientData.created_at]
        );
        inserted++;
      } catch (error) {
        logger.warn(`Failed to insert client ${clientData.id}:`, (error as Error).message);
      }
    }
    
    return inserted;
  }

  /**
   * Insere serviços
   */
  private async insertServices(client: PoolClient, services: SeedData['services']): Promise<number> {
    let inserted = 0;
    
    for (const serviceData of services) {
      try {
        await client.query(
          `INSERT INTO services (id, tenant_id, name, description, duration_minutes, price, active, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
           ON CONFLICT (id) DO NOTHING`,
          [serviceData.id, serviceData.tenant_id, serviceData.name, serviceData.description,
           serviceData.duration_minutes, serviceData.price, serviceData.active, serviceData.created_at]
        );
        inserted++;
      } catch (error) {
        logger.warn(`Failed to insert service ${serviceData.id}:`, (error as Error).message);
      }
    }
    
    return inserted;
  }

  /**
   * Insere profissionais
   */
  private async insertProfessionals(client: PoolClient, professionals: SeedData['professionals']): Promise<number> {
    let inserted = 0;
    
    for (const professionalData of professionals) {
      try {
        await client.query(
          `INSERT INTO professionals (id, tenant_id, name, email, phone, specialties, active, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
           ON CONFLICT (id) DO NOTHING`,
          [professionalData.id, professionalData.tenant_id, professionalData.name, 
           professionalData.email, professionalData.phone, JSON.stringify(professionalData.specialties),
           professionalData.active, professionalData.created_at]
        );
        inserted++;
      } catch (error) {
        logger.warn(`Failed to insert professional ${professionalData.id}:`, (error as Error).message);
      }
    }
    
    return inserted;
  }

  /**
   * Insere agendamentos
   */
  private async insertAppointments(client: PoolClient, appointments: SeedData['appointments']): Promise<number> {
    let inserted = 0;
    
    for (const appointmentData of appointments) {
      try {
        await client.query(
          `INSERT INTO appointments (id, tenant_id, client_id, professional_id, service_id, 
                                   scheduled_at, status, notes, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
           ON CONFLICT (id) DO NOTHING`,
          [appointmentData.id, appointmentData.tenant_id, appointmentData.client_id,
           appointmentData.professional_id, appointmentData.service_id, appointmentData.scheduled_at,
           appointmentData.status, appointmentData.notes, appointmentData.created_at]
        );
        inserted++;
      } catch (error) {
        logger.warn(`Failed to insert appointment ${appointmentData.id}:`, (error as Error).message);
      }
    }
    
    return inserted;
  }

  /**
   * Verifica se as tabelas necessárias existem
   */
  private async verifyTables(): Promise<void> {
    const requiredTables = ['clients', 'services', 'professionals', 'appointments'];
    
    for (const table of requiredTables) {
      const result = await this.pgPool.query(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables 
           WHERE table_schema = 'public' 
           AND table_name = $1
         )`,
        [table]
      );
      
      if (!result.rows[0].exists) {
        throw new Error(`Required table '${table}' does not exist`);
      }
    }
    
    logger.info('All required tables verified');
  }

  /**
   * Obtém estatísticas dos dados de seed
   */
  async getStats(): Promise<{
    clients: number;
    services: number;
    professionals: number;
    appointments: number;
    lastSeeded?: Date;
  }> {
    try {
      const [clientsResult, servicesResult, professionalsResult, appointmentsResult] = await Promise.all([
        this.pgPool.query('SELECT COUNT(*) FROM clients WHERE tenant_id = $1', [this.defaultTenantId]),
        this.pgPool.query('SELECT COUNT(*) FROM services WHERE tenant_id = $1', [this.defaultTenantId]),
        this.pgPool.query('SELECT COUNT(*) FROM professionals WHERE tenant_id = $1', [this.defaultTenantId]),
        this.pgPool.query('SELECT COUNT(*) FROM appointments WHERE tenant_id = $1', [this.defaultTenantId])
      ]);

      // Buscar data do último seed
      const lastSeededResult = await this.pgPool.query(
        'SELECT MAX(created_at) as last_seeded FROM clients WHERE tenant_id = $1',
        [this.defaultTenantId]
      );

      return {
        clients: parseInt(clientsResult.rows[0].count),
        services: parseInt(servicesResult.rows[0].count),
        professionals: parseInt(professionalsResult.rows[0].count),
        appointments: parseInt(appointmentsResult.rows[0].count),
        lastSeeded: lastSeededResult.rows[0].last_seeded
      };
    } catch (error) {
      logger.error('Failed to get seed stats:', error);
      throw error;
    }
  }
}