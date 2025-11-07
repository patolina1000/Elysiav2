/**
 * Testes de validação
 * Testa validações de entrada, slug, etc
 */

describe('Validações', () => {
  
  describe('Validação de Slug (Correção #6)', () => {
    // Regex usada no server.js
    const slugRegex = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
    
    it('deve aceitar slugs válidos', () => {
      const validSlugs = [
        'bot-test',
        'bot_test',
        'bot123',
        'test-bot-2024',
        'MyBot123',
        'ab', // Mínimo de 2 caracteres (1 inicial + 1)
        'a'.repeat(64) // Máximo 64 caracteres
      ];
      
      validSlugs.forEach(slug => {
        expect(slugRegex.test(slug)).toBe(true);
      });
    });
    
    it('deve rejeitar slugs inválidos', () => {
      const invalidSlugs = [
        '',                     // Vazio
        ' ',                    // Apenas espaço
        '../../../etc/passwd',  // Path traversal
        'bot<script>',          // XSS
        'bot\ntest',            // Quebra de linha
        'bot test',             // Espaço
        'bot@test',             // @ não permitido
        'bot.test',             // . sozinho no meio
        'a'.repeat(65),         // Muito longo (>64)
        '-bot',                 // Começa com hífen
        '_bot'                  // Começa com underscore
      ];
      
      invalidSlugs.forEach(slug => {
        expect(slugRegex.test(slug)).toBe(false);
      });
    });
    
    it('deve ser case-insensitive', () => {
      expect(slugRegex.test('BotTest')).toBe(true);
      expect(slugRegex.test('bottest')).toBe(true);
      expect(slugRegex.test('BOTTEST')).toBe(true);
    });
  });
  
  describe('Validação de Token', () => {
    const { maskToken } = require('../lib/tokenService');
    
    it('deve mascarar token corretamente', () => {
      const token = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
      const masked = maskToken(token);
      
      expect(masked).toContain('...');
      expect(masked).not.toContain('ABCdef');
      expect(masked.length).toBeLessThan(token.length);
    });
    
    it('deve lidar com token null', () => {
      expect(maskToken(null)).toBe(null);
      expect(maskToken(undefined)).toBe(null);
      expect(maskToken('')).toBe(null);
    });
    
    it('deve mascarar tokens curtos', () => {
      const shortToken = '12345';
      const masked = maskToken(shortToken);
      expect(masked).toBe('***');
    });
  });
  
  describe('Validação de Environment', () => {
    
    it('deve ter variáveis de ambiente críticas definidas', () => {
      // DATABASE_URL é opcional (pode usar memória)
      // ADMIN_API_TOKEN deve estar definido
      expect(process.env.ADMIN_API_TOKEN).toBeDefined();
      expect(process.env.ADMIN_API_TOKEN.length).toBeGreaterThan(0);
    });
    
    it('NODE_ENV deve ser válido', () => {
      const validEnvs = ['development', 'production', 'test', undefined];
      expect(validEnvs).toContain(process.env.NODE_ENV);
    });
  });
});
