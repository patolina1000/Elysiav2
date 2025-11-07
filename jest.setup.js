// Setup global para testes Jest
require('dotenv').config();

// Aumentar timeout para testes que fazem I/O
jest.setTimeout(10000);

// Mock de console para testes mais limpos (opcional)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
//   error: jest.fn(),
// };
