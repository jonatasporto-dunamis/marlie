import { DateTime } from 'luxon';
import {
  resolveDateRelative,
  resolveCompleteDateTime,
  combineDateAndTime,
  formatDateBR,
  formatTimeBR,
  isBusinessDay,
  getNextBusinessDay,
  isPastDateTime,
  getNowInBahia,
  resolvePeriodToTime
} from '../utils/date-resolver';

describe('Date Resolver', () => {
  const BAHIA_TIMEZONE = 'America/Bahia';
  
  // Data de referência fixa para testes determinísticos
  const referenceDate = DateTime.fromISO('2024-01-22T10:00:00', { zone: BAHIA_TIMEZONE }); // Segunda-feira

  describe('resolveDateRelative', () => {
    it('should resolve "hoje" correctly', () => {
      const result = resolveDateRelative('hoje', referenceDate);
      expect(result.dateISO).toBe('2024-01-22');
      expect(result.dateRel).toBe('hoje');
      expect(result.dayOfWeek).toBe(1); // Segunda
      expect(result.isBusinessDay).toBe(false); // Segunda não é dia útil
    });

    it('should resolve "amanhã" correctly', () => {
      const result = resolveDateRelative('amanhã', referenceDate);
      expect(result.dateISO).toBe('2024-01-23');
      expect(result.dateRel).toBe('amanhã');
      expect(result.dayOfWeek).toBe(2); // Terça
      expect(result.isBusinessDay).toBe(true); // Terça é dia útil
    });

    it('should resolve "depois de amanhã" correctly', () => {
      const result = resolveDateRelative('depois de amanhã', referenceDate);
      expect(result.dateISO).toBe('2024-01-24');
      expect(result.dateRel).toBe('depois de amanhã');
      expect(result.dayOfWeek).toBe(3); // Quarta
      expect(result.isBusinessDay).toBe(true);
    });

    it('should resolve weekdays correctly', () => {
      const terça = resolveDateRelative('terça', referenceDate);
      expect(terça.dateISO).toBe('2024-01-23'); // Próxima terça
      expect(terça.dayOfWeek).toBe(2);
      expect(terça.isBusinessDay).toBe(true);

      const sexta = resolveDateRelative('sexta', referenceDate);
      expect(sexta.dateISO).toBe('2024-01-26'); // Próxima sexta
      expect(sexta.dayOfWeek).toBe(5);
      expect(sexta.isBusinessDay).toBe(true);

      const domingo = resolveDateRelative('domingo', referenceDate);
      expect(domingo.dateISO).toBe('2024-01-28'); // Próximo domingo
      expect(domingo.dayOfWeek).toBe(7);
      expect(domingo.isBusinessDay).toBe(false);
    });

    it('should handle unknown date relative as hoje', () => {
      const result = resolveDateRelative('data_inexistente', referenceDate);
      expect(result.dateISO).toBe('2024-01-22');
      expect(result.dateRel).toBe('data_inexistente');
    });
  });

  describe('resolvePeriodToTime', () => {
    it('should resolve periods to correct times', () => {
      expect(resolvePeriodToTime('manhã')).toBe('09:00');
      expect(resolvePeriodToTime('tarde')).toBe('14:00');
      expect(resolvePeriodToTime('noite')).toBe('19:00');
    });
  });

  describe('combineDateAndTime', () => {
    it('should combine date and time correctly', () => {
      const result = combineDateAndTime('2024-01-22', '14:30');
      expect(result.toISO()).toContain('2024-01-22T14:30:00');
      expect(result.zoneName).toBe(BAHIA_TIMEZONE);
    });

    it('should use period when time is not provided', () => {
      const result = combineDateAndTime('2024-01-22', undefined, 'tarde');
      expect(result.toISO()).toContain('2024-01-22T14:00:00');
    });

    it('should default to 09:00 when neither time nor period provided', () => {
      const result = combineDateAndTime('2024-01-22');
      expect(result.toISO()).toContain('2024-01-22T09:00:00');
    });
  });

  describe('isBusinessDay', () => {
    it('should identify business days correctly', () => {
      expect(isBusinessDay('2024-01-22')).toBe(false); // Segunda
      expect(isBusinessDay('2024-01-23')).toBe(true);  // Terça
      expect(isBusinessDay('2024-01-24')).toBe(true);  // Quarta
      expect(isBusinessDay('2024-01-25')).toBe(true);  // Quinta
      expect(isBusinessDay('2024-01-26')).toBe(true);  // Sexta
      expect(isBusinessDay('2024-01-27')).toBe(true);  // Sábado
      expect(isBusinessDay('2024-01-28')).toBe(false); // Domingo
    });
  });

  describe('getNextBusinessDay', () => {
    it('should get next business day correctly', () => {
      expect(getNextBusinessDay('2024-01-21')).toBe('2024-01-23'); // Domingo -> Terça
      expect(getNextBusinessDay('2024-01-22')).toBe('2024-01-23'); // Segunda -> Terça
      expect(getNextBusinessDay('2024-01-26')).toBe('2024-01-27'); // Sexta -> Sábado
      expect(getNextBusinessDay('2024-01-27')).toBe('2024-01-30'); // Sábado -> Terça
    });
  });

  describe('formatDateBR', () => {
    it('should format date in Brazilian Portuguese', () => {
      const formatted = formatDateBR('2024-01-22');
      expect(formatted).toContain('segunda');
      expect(formatted).toContain('22');
      expect(formatted).toContain('janeiro');
      expect(formatted).toContain('2024');
    });
  });

  describe('formatTimeBR', () => {
    it('should format time correctly', () => {
      expect(formatTimeBR('14:30')).toBe('14:30');
      expect(formatTimeBR('09:00')).toBe('09:00');
    });
  });

  describe('isPastDateTime', () => {
    it('should detect past dates correctly', () => {
      // Teste com data no passado
      expect(isPastDateTime('2020-01-01', '10:00')).toBe(true);
      
      // Teste com data no futuro distante
      expect(isPastDateTime('2030-01-01', '10:00')).toBe(false);
    });
  });

  describe('resolveCompleteDateTime', () => {
    it('should resolve complete datetime from dateRel', () => {
      const result = resolveCompleteDateTime('amanhã', undefined, '14:30', undefined, referenceDate);
      expect(result.dateISO).toBe('2024-01-23');
      expect(result.timeISO).toBe('14:30');
      expect(result.isBusinessDay).toBe(true);
    });

    it('should resolve complete datetime from dateISO', () => {
      const result = resolveCompleteDateTime(undefined, '2024-01-25', undefined, 'tarde', referenceDate);
      expect(result.dateISO).toBe('2024-01-25');
      expect(result.timeISO).toBe('14:00');
      expect(result.period).toBe('tarde');
    });

    it('should fallback to hoje when no date provided', () => {
      const result = resolveCompleteDateTime(undefined, undefined, '10:00', undefined, referenceDate);
      expect(result.dateISO).toBe('2024-01-22');
      expect(result.timeISO).toBe('10:00');
    });

    it('should handle period without time', () => {
      const result = resolveCompleteDateTime('sexta', undefined, undefined, 'manhã', referenceDate);
      expect(result.dateISO).toBe('2024-01-26');
      expect(result.timeISO).toBe('09:00');
      expect(result.period).toBe('manhã');
    });
  });

  describe('getNowInBahia', () => {
    it('should return current time in Bahia timezone', () => {
      const now = getNowInBahia();
      expect(now.zoneName).toBe(BAHIA_TIMEZONE);
      expect(now.isValid).toBe(true);
    });
  });
});