import { Router, Request, Response } from 'express';
import { adminAuth, requireAdminToken } from '../middleware/tokenAuth';
import { adminRateLimit } from '../middleware/rateLimiting';
import { getCurrentTenantId } from '../middleware/tenant';
import { TrinksAppointmentsService } from '../services/trinks-appointments';
import { NotificationsLogService } from '../services/notifications-log';
import { createPreVisitWorker } from '../workers/previsit-worker';
import { format, parseISO } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import logger from '../utils/logger';

const router = Router();

/**
 * Interface para request de preview
 */
interface PrevisitPreviewRequest {
  date: string; // YYYY-MM-DD
}

/**
 * Interface para request de execução
 */
interface PrevisitRunRequest {
  date: string; // YYYY-MM-DD
}

/**
 * Interface para request de auditoria
 */
interface PrevisitAuditRequest {
  date: string; // YYYY-MM-DD
}

/**
 * Interface para divergência encontrada
 */
interface Divergence {
  type: 'missing_notification' | 'orphan_notification';
  appointment_id?: string;
  notification_id?: string;
  phone?: string;
  appointment_time?: string;
  notification_time?: string;
  details: string;
}

/**
 * Aplicar middlewares de segurança
 */
router.use(adminRateLimit);
router.use(adminAuth);
router.use(requireAdminToken);

/**
 * GET /admin/previsit/preview
 * Preview dos agendamentos que receberiam notificação de pré-visita
 */
router.get('/preview', async (req: Request, res: Response) => {
  try {
    const { date } = req.query as { date?: string };
    
    if (!date) {
      return res.status(400).json({
        ok: false,
        error: 'Parameter "date" is required (format: YYYY-MM-DD)',
        timestamp: new Date().toISOString()
      });
    }

    // Validar formato da data
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid date format. Use YYYY-MM-DD',
        timestamp: new Date().toISOString()
      });
    }

    const tenantId = getCurrentTenantId(req) || 'default';
    const trinksService = new TrinksAppointmentsService(tenantId);
    
    // Construir range de horários para o dia
    const dataInicio = `${date}T00:01:00`;
    const dataFim = `${date}T23:59:00`;
    
    logger.info('Admin preview previsit appointments', {
      tenantId,
      date,
      admin_user: (req as any).user?.id
    });

    // Buscar agendamentos do Trinks
    const response = await trinksService.fetchAppointments(dataInicio, dataFim, 1);
    
    // Filtrar apenas agendamentos confirmados
    const confirmedAppointments = response.agendamentos.filter(
      apt => apt.status === 'confirmado'
    );

    // Preparar dados para preview
    const preview = {
      date,
      total_appointments: response.agendamentos.length,
      confirmed_appointments: confirmedAppointments.length,
      appointments: confirmedAppointments.map(apt => ({
        id: apt.id,
        client_name: apt.cliente.nome,
        client_phone: apt.cliente.telefone,
        service_name: apt.servico.nome,
        professional_name: apt.profissional.nome,
        start_time: apt.dataHoraInicio,
        end_time: apt.dataHoraFim,
        status: apt.status,
        dedupeKey: `previsit_${apt.id}_${format(parseISO(apt.dataHoraInicio), 'yyyy-MM-dd')}`
      }))
    };

    res.json({
      ok: true,
      data: preview,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error in previsit preview:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /admin/previsit/run
 * Executa o worker de pré-visita para uma data específica
 */
router.post('/run', async (req: Request, res: Response) => {
  try {
    const { date } = req.body as PrevisitRunRequest;
    
    if (!date) {
      return res.status(400).json({
        ok: false,
        error: 'Field "date" is required (format: YYYY-MM-DD)',
        timestamp: new Date().toISOString()
      });
    }

    // Validar formato da data
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid date format. Use YYYY-MM-DD',
        timestamp: new Date().toISOString()
      });
    }

    const tenantId = getCurrentTenantId(req) || 'default';
    
    logger.info('Admin triggered previsit worker', {
      tenantId,
      date,
      admin_user: (req as any).user?.id
    });

    // Criar worker temporário para execução manual
    const worker = await createPreVisitWorker(tenantId);
    
    // Executar para a data específica
    const stats = await worker.executePreVisitRun();
    
    logger.info('Previsit worker execution completed', {
      tenantId,
      date,
      stats,
      admin_user: (req as any).user?.id
    });

    res.json({
      ok: true,
      scheduled_for: date,
      execution_stats: stats,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error running previsit worker:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /admin/previsit/audit
 * Auditoria de divergências entre notificações enviadas e agenda real
 */
router.get('/audit', async (req: Request, res: Response) => {
  try {
    const { date } = req.query as { date?: string };
    
    if (!date) {
      return res.status(400).json({
        ok: false,
        error: 'Parameter "date" is required (format: YYYY-MM-DD)',
        timestamp: new Date().toISOString()
      });
    }

    // Validar formato da data
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid date format. Use YYYY-MM-DD',
        timestamp: new Date().toISOString()
      });
    }

    const tenantId = getCurrentTenantId(req) || 'default';
    
    logger.info('Admin audit previsit divergences', {
      tenantId,
      date,
      admin_user: (req as any).user?.id
    });

    const divergences = await auditDivergences(tenantId, date);
    
    res.json({
      ok: true,
      date,
      total_divergences: divergences.length,
      divergences,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error in previsit audit:', error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Função auxiliar para auditoria de divergências
 */
async function auditDivergences(tenantId: string, date: string): Promise<Divergence[]> {
  const divergences: Divergence[] = [];
  
  try {
    const trinksService = new TrinksAppointmentsService(tenantId);
    const notificationsService = new NotificationsLogService(tenantId);
    
    // Buscar notificações enviadas para a data
    const notifications = await notificationsService.getNotifications(
      date,
      date,
      'previsit'
    );
    
    // Buscar agendamentos reais da API Trinks para a data
    const dataInicio = `${date}T00:01:00`;
    const dataFim = `${date}T23:59:00`;
    const realAppointments = await trinksService.fetchAppointments(dataInicio, dataFim, 1);
    
    // Filtrar agendamentos confirmados
    const confirmedAppointments = realAppointments.agendamentos.filter(
      apt => apt.status === 'confirmado'
    );
    
    // Verificar agendamentos confirmados sem notificação
    for (const apt of confirmedAppointments) {
      const dedupeKey = `previsit_${apt.id}_${format(parseISO(apt.dataHoraInicio), 'yyyy-MM-dd')}`;
      const hasNotification = notifications.some((n: any) => n.dedupeKey === dedupeKey);
      
      if (!hasNotification) {
        divergences.push({
          type: 'missing_notification',
          appointment_id: apt.id,
          phone: apt.cliente.telefone,
          appointment_time: apt.dataHoraInicio,
          details: `Agendamento confirmado sem notificação de pré-visita enviada`
        });
      }
    }
    
    // Verificar notificações órfãs (sem agendamento correspondente)
    for (const notification of notifications) {
      if (notification.dedupeKey && notification.dedupeKey.startsWith('previsit_')) {
        const appointmentId = notification.dedupeKey.split('_')[1];
        const hasAppointment = confirmedAppointments.some(apt => apt.id === appointmentId);
        
        if (!hasAppointment) {
          divergences.push({
            type: 'orphan_notification',
            notification_id: notification.id,
            phone: notification.phone,
            notification_time: notification.sentAt.toISOString(),
            details: `Notificação enviada para agendamento que não existe ou não está confirmado`
          });
        }
      }
    }
    
  } catch (error) {
    logger.error('Error in audit divergences:', error);
    throw error;
  }
  
  return divergences;
}

export default router;