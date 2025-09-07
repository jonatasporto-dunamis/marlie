import { TrinksAppointment } from './trinks-appointments';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/**
 * Interface para dados do template
 */
export interface TemplateData {
  clienteNome: string;
  servicoNome: string;
  profissionalNome: string;
  dataHora: string;
  dataFormatada: string;
  horaFormatada: string;
  estabelecimentoNome?: string;
  endereco?: string;
  telefoneContato?: string;
}

/**
 * Interface para slot de reagendamento
 */
export interface RebookSlot {
  dataHoraInicio: string;
  dataFormatada: string;
  horaFormatada: string;
  profissionalNome?: string;
}

/**
 * Classe para templates de mensagens automáticas
 */
export class AutoMessageTemplates {
  private estabelecimentoNome: string;
  private endereco: string;
  private telefoneContato: string;

  constructor(
    estabelecimentoNome: string = 'Nossa Clínica',
    endereco: string = '',
    telefoneContato: string = ''
  ) {
    this.estabelecimentoNome = estabelecimentoNome;
    this.endereco = endereco;
    this.telefoneContato = telefoneContato;
  }

  /**
   * Converte agendamento Trinks para dados do template
   */
  private appointmentToTemplateData(appointment: TrinksAppointment): TemplateData {
    const dataHora = parseISO(appointment.dataHoraInicio);
    
    return {
      clienteNome: appointment.cliente.nome,
      servicoNome: appointment.servico.nome,
      profissionalNome: appointment.profissional.nome,
      dataHora: appointment.dataHoraInicio,
      dataFormatada: format(dataHora, "EEEE, dd 'de' MMMM", { locale: ptBR }),
      horaFormatada: format(dataHora, 'HH:mm', { locale: ptBR }),
      estabelecimentoNome: this.estabelecimentoNome,
      endereco: this.endereco,
      telefoneContato: this.telefoneContato
    };
  }

  /**
   * Template de mensagem de pré-visita (lembrete)
   */
  getPreVisitMessage(appointment: TrinksAppointment): string {
    const data = this.appointmentToTemplateData(appointment);
    
    return `🗓️ *Lembrete de Consulta*

Olá, ${data.clienteNome}!

Lembramos que você tem um agendamento marcado:

📅 *Data:* ${data.dataFormatada}
⏰ *Horário:* ${data.horaFormatada}
👩‍⚕️ *Profissional:* ${data.profissionalNome}
🔧 *Serviço:* ${data.servicoNome}

📍 *Local:* ${data.estabelecimentoNome}${data.endereco ? `\n${data.endereco}` : ''}

⚠️ *Importante:*
• Chegue 15 minutos antes
• Traga um documento com foto
• Em caso de atraso, entre em contato

${data.telefoneContato ? `📞 Dúvidas: ${data.telefoneContato}` : ''}

Aguardamos você! 😊`;
  }

  /**
   * Template de pergunta no-show shield
   */
  getNoShowShieldQuestion(appointment: TrinksAppointment): string {
    const data = this.appointmentToTemplateData(appointment);
    
    return `🤔 *Confirmação de Presença*

Olá, ${data.clienteNome}!

Você tem um agendamento marcado para *amanhã*:

📅 ${data.dataFormatada}
⏰ ${data.horaFormatada}
👩‍⚕️ ${data.profissionalNome}
🔧 ${data.servicoNome}

*Você conseguirá comparecer?*

✅ Digite *SIM* se você virá
❌ Digite *NÃO* se precisar reagendar

Aguardo sua confirmação! 😊`;
  }

  /**
   * Template de confirmação positiva (SIM)
   */
  getNoShowConfirmationYes(appointment: TrinksAppointment): string {
    const data = this.appointmentToTemplateData(appointment);
    
    return `✅ *Presença Confirmada!*

Perfeito, ${data.clienteNome}!

Sua presença está confirmada para:
📅 ${data.dataFormatada}
⏰ ${data.horaFormatada}

Lembretes importantes:
• Chegue 15 minutos antes
• Traga documento com foto

Te esperamos! 😊`;
  }

  /**
   * Template de oferecimento de reagendamento (NÃO)
   */
  getNoShowRebookOffer(appointment: TrinksAppointment, availableSlots: RebookSlot[]): string {
    const data = this.appointmentToTemplateData(appointment);
    
    let message = `📅 *Reagendamento Disponível*

Sem problemas, ${data.clienteNome}!

Vamos reagendar seu agendamento de *${data.servicoNome}*.

Temos estas opções disponíveis:

`;

    availableSlots.forEach((slot, index) => {
      message += `${index + 1}️⃣ ${slot.dataFormatada} às ${slot.horaFormatada}${slot.profissionalNome ? ` - ${slot.profissionalNome}` : ''}\n`;
    });

    message += `\n*Digite o número da opção desejada* (1, 2, 3...)

Ou digite *OUTRO* se nenhuma opção serve.

😊 Estamos aqui para ajudar!`;

    return message;
  }

  /**
   * Template de confirmação de reagendamento
   */
  getRebookConfirmation(
    oldAppointment: TrinksAppointment,
    newSlot: RebookSlot
  ): string {
    const oldData = this.appointmentToTemplateData(oldAppointment);
    
    return `✅ *Reagendamento Confirmado!*

Perfeito, ${oldData.clienteNome}!

Seu agendamento foi reagendado:

🔄 *De:* ${oldData.dataFormatada} às ${oldData.horaFormatada}
📅 *Para:* ${newSlot.dataFormatada} às ${newSlot.horaFormatada}

🔧 *Serviço:* ${oldData.servicoNome}
${newSlot.profissionalNome ? `👩‍⚕️ *Profissional:* ${newSlot.profissionalNome}` : ''}

Lembretes:
• Chegue 15 minutos antes
• Traga documento com foto

Obrigado pela compreensão! 😊`;
  }

  /**
   * Template de erro no reagendamento
   */
  getRebookError(appointment: TrinksAppointment): string {
    const data = this.appointmentToTemplateData(appointment);
    
    return `❌ *Ops! Algo deu errado*

Desculpe, ${data.clienteNome}!

Não conseguimos reagendar automaticamente seu horário.

${data.telefoneContato ? `📞 Entre em contato: ${data.telefoneContato}` : '📞 Entre em contato conosco'}

Nossa equipe te ajudará a encontrar um novo horário! 😊`;
  }

  /**
   * Template de nenhuma opção disponível
   */
  getNoSlotsAvailable(appointment: TrinksAppointment): string {
    const data = this.appointmentToTemplateData(appointment);
    
    return `📅 *Reagendamento Necessário*

Olá, ${data.clienteNome}!

Infelizmente não temos horários disponíveis próximos para reagendamento automático.

${data.telefoneContato ? `📞 Entre em contato: ${data.telefoneContato}` : '📞 Entre em contato conosco'}

Nossa equipe te ajudará a encontrar o melhor horário! 😊`;
  }

  /**
   * Template de auditoria de divergências
   */
  getAuditReport(
    date: string,
    totalTrinks: number,
    totalNotified: number,
    missing: number,
    extra: number
  ): string {
    const dateFormatted = format(parseISO(date), "dd 'de' MMMM 'de' yyyy", { locale: ptBR });
    
    return `📊 *Relatório de Auditoria*

📅 *Data:* ${dateFormatted}

📈 *Resumo:*
• Agendamentos Trinks: ${totalTrinks}
• Notificações Enviadas: ${totalNotified}
• Não Notificados: ${missing}
• Notificações Extras: ${extra}

${missing > 0 ? '⚠️ Há agendamentos não notificados!' : '✅ Todos os agendamentos foram notificados'}
${extra > 0 ? '⚠️ Há notificações sem agendamento correspondente!' : ''}`;
  }

  /**
   * Template de mensagem de teste
   */
  getTestMessage(): string {
    return `🧪 *Teste de Mensagem Automática*

Este é um teste do sistema de mensagens automáticas.

✅ Sistema funcionando corretamente!

Data/Hora: ${format(new Date(), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}`;
  }
}

/**
 * Factory function para criar instância dos templates
 */
export function createAutoMessageTemplates(
  estabelecimentoNome?: string,
  endereco?: string,
  telefoneContato?: string
): AutoMessageTemplates {
  return new AutoMessageTemplates(estabelecimentoNome, endereco, telefoneContato);
}