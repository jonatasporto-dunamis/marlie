import { Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import logger from '../utils/logger';

interface SecretRotationConfig {
  minSecretLength: number;
  maxSecretLength: number;
  allowedChars: string;
  rotationHistory: number; // Quantos secrets manter no histórico
}

interface SecretEntry {
  secret: string;
  createdAt: Date;
  rotatedAt?: Date;
  active: boolean;
}

/**
 * Serviço para rotação segura de HMAC secrets
 */
export class SecretRotationService {
  private config: SecretRotationConfig;
  private secretHistory: SecretEntry[] = [];

  constructor(config: SecretRotationConfig) {
    this.config = config;
    this.loadCurrentSecrets();
  }

  /**
   * Carrega secrets atuais das variáveis de ambiente
   */
  private loadCurrentSecrets(): void {
    const currentSecret = process.env.HMAC_SECRET_CURRENT;
    const prevSecret = process.env.HMAC_SECRET_PREV;

    if (currentSecret) {
      this.secretHistory.push({
        secret: currentSecret,
        createdAt: new Date(),
        active: true
      });
    }

    if (prevSecret && prevSecret !== currentSecret) {
      this.secretHistory.push({
        secret: prevSecret,
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Assumir 1 dia atrás
        active: false
      });
    }
  }

  /**
   * Gera um novo secret seguro
   */
  public generateSecret(length?: number): string {
    const secretLength = length || this.config.minSecretLength;
    
    if (secretLength < this.config.minSecretLength || secretLength > this.config.maxSecretLength) {
      throw new Error(`Secret length must be between ${this.config.minSecretLength} and ${this.config.maxSecretLength}`);
    }

    // Gerar bytes aleatórios criptograficamente seguros
    const randomBytesBuffer = randomBytes(Math.ceil(secretLength * 3 / 4));
    
    // Converter para base64 e limpar caracteres não permitidos
    let secret = randomBytesBuffer.toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, secretLength);

    // Garantir que tem o tamanho correto
    while (secret.length < secretLength) {
      const additionalBytes = randomBytes(8);
      secret += additionalBytes.toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    }

    return secret.substring(0, secretLength);
  }

  /**
   * Valida um secret proposto
   */
  public validateSecret(secret: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!secret) {
      errors.push('Secret cannot be empty');
      return { valid: false, errors };
    }

    if (secret.length < this.config.minSecretLength) {
      errors.push(`Secret must be at least ${this.config.minSecretLength} characters`);
    }

    if (secret.length > this.config.maxSecretLength) {
      errors.push(`Secret must be at most ${this.config.maxSecretLength} characters`);
    }

    // Verificar caracteres permitidos
    const allowedCharsRegex = new RegExp(`^[${this.config.allowedChars}]+$`);
    if (!allowedCharsRegex.test(secret)) {
      errors.push('Secret contains invalid characters');
    }

    // Verificar se não é igual ao secret atual
    const currentSecret = this.getCurrentSecret();
    if (currentSecret && secret === currentSecret.secret) {
      errors.push('New secret cannot be the same as current secret');
    }

    // Verificar se não foi usado recentemente
    const recentlyUsed = this.secretHistory.some(entry => 
      entry.secret === secret && 
      (Date.now() - entry.createdAt.getTime()) < (7 * 24 * 60 * 60 * 1000) // 7 dias
    );

    if (recentlyUsed) {
      errors.push('Secret was used recently and cannot be reused');
    }

    // Verificar entropia (complexidade)
    if (!this.hasGoodEntropy(secret)) {
      errors.push('Secret does not have sufficient entropy');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Verifica se o secret tem boa entropia
   */
  private hasGoodEntropy(secret: string): boolean {
    // Verificar variedade de caracteres
    const hasLower = /[a-z]/.test(secret);
    const hasUpper = /[A-Z]/.test(secret);
    const hasNumber = /[0-9]/.test(secret);
    
    const varietyScore = [hasLower, hasUpper, hasNumber].filter(Boolean).length;
    
    // Verificar repetições
    const uniqueChars = new Set(secret).size;
    const repetitionRatio = uniqueChars / secret.length;
    
    return varietyScore >= 2 && repetitionRatio > 0.5;
  }

  /**
   * Rotaciona o secret atual
   */
  public rotateSecret(newSecret: string): { success: boolean; message: string; secrets?: any } {
    try {
      // Validar novo secret
      const validation = this.validateSecret(newSecret);
      if (!validation.valid) {
        return {
          success: false,
          message: `Validation failed: ${validation.errors.join(', ')}`
        };
      }

      // Obter secret atual
      const currentSecret = this.getCurrentSecret();
      
      // Marcar secret atual como inativo
      if (currentSecret) {
        currentSecret.active = false;
        currentSecret.rotatedAt = new Date();
      }

      // Adicionar novo secret
      const newSecretEntry: SecretEntry = {
        secret: newSecret,
        createdAt: new Date(),
        active: true
      };
      
      this.secretHistory.unshift(newSecretEntry);

      // Manter apenas o histórico configurado
      if (this.secretHistory.length > this.config.rotationHistory) {
        this.secretHistory = this.secretHistory.slice(0, this.config.rotationHistory);
      }

      // Preparar secrets para retorno (para atualização das variáveis de ambiente)
      const secrets = {
        current: newSecret,
        previous: currentSecret?.secret || null
      };

      logger.info('HMAC secret rotated successfully', {
        timestamp: new Date().toISOString(),
        secretLength: newSecret.length,
        previousSecretExists: !!currentSecret,
        historySize: this.secretHistory.length
      });

      return {
        success: true,
        message: 'Secret rotated successfully',
        secrets
      };
    } catch (error) {
      logger.error('Secret rotation failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      return {
        success: false,
        message: 'Internal error during secret rotation'
      };
    }
  }

  /**
   * Obtém o secret atual ativo
   */
  public getCurrentSecret(): SecretEntry | null {
    return this.secretHistory.find(entry => entry.active) || null;
  }

  /**
   * Obtém o secret anterior
   */
  public getPreviousSecret(): SecretEntry | null {
    const inactiveSecrets = this.secretHistory.filter(entry => !entry.active);
    return inactiveSecrets.length > 0 ? inactiveSecrets[0] : null;
  }

  /**
   * Obtém todos os secrets válidos (atual + anterior)
   */
  public getValidSecrets(): string[] {
    const current = this.getCurrentSecret();
    const previous = this.getPreviousSecret();
    
    const secrets: string[] = [];
    if (current) secrets.push(current.secret);
    if (previous) secrets.push(previous.secret);
    
    return secrets;
  }

  /**
   * Obtém estatísticas dos secrets
   */
  public getStats(): any {
    const current = this.getCurrentSecret();
    const previous = this.getPreviousSecret();
    
    return {
      currentSecret: current ? {
        createdAt: current.createdAt,
        age: Date.now() - current.createdAt.getTime(),
        length: current.secret.length
      } : null,
      previousSecret: previous ? {
        createdAt: previous.createdAt,
        rotatedAt: previous.rotatedAt,
        age: Date.now() - previous.createdAt.getTime(),
        length: previous.secret.length
      } : null,
      historySize: this.secretHistory.length,
      totalRotations: this.secretHistory.filter(s => s.rotatedAt).length
    };
  }
}

/**
 * Factory function para criar serviço de rotação
 */
export function createSecretRotationService(config: Partial<SecretRotationConfig> = {}) {
  const defaultConfig: SecretRotationConfig = {
    minSecretLength: 24,
    maxSecretLength: 128,
    allowedChars: 'a-zA-Z0-9',
    rotationHistory: 5
  };

  const finalConfig = { ...defaultConfig, ...config };
  return new SecretRotationService(finalConfig);
}

/**
 * Instância global do serviço
 */
export const secretRotationService = createSecretRotationService();

/**
 * Controller para endpoint de rotação de secret
 */
export async function rotateSecretController(req: Request, res: Response) {
  try {
    const { new_secret } = req.body;
    
    if (!new_secret) {
      return res.status(400).json({
        error: 'new_secret is required in request body'
      });
    }

    const result = secretRotationService.rotateSecret(new_secret);
    
    if (result.success) {
      // Log de auditoria
      logger.info('Secret rotation requested via API', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
      });

      return res.json({
        ok: true,
        message: result.message,
        secrets: result.secrets,
        stats: secretRotationService.getStats()
      });
    } else {
      return res.status(400).json({
        error: result.message
      });
    }
  } catch (error) {
    logger.error('Secret rotation controller error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ip: req.ip
    });
    
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
}

/**
 * Controller para gerar novo secret automaticamente
 */
export async function generateSecretController(req: Request, res: Response) {
  try {
    const { length } = req.query;
    const secretLength = length ? parseInt(length as string) : undefined;
    
    const newSecret = secretRotationService.generateSecret(secretLength);
    const validation = secretRotationService.validateSecret(newSecret);
    
    return res.json({
      secret: newSecret,
      length: newSecret.length,
      valid: validation.valid,
      errors: validation.errors
    });
  } catch (error) {
    logger.error('Secret generation controller error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ip: req.ip
    });
    
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
}

/**
 * Controller para obter estatísticas dos secrets
 */
export async function getSecretStatsController(req: Request, res: Response) {
  try {
    const stats = secretRotationService.getStats();
    
    return res.json({
      stats,
      validSecretsCount: secretRotationService.getValidSecrets().length
    });
  } catch (error) {
    logger.error('Secret stats controller error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ip: req.ip
    });
    
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
}