// Script simples para testar o Agente Marlie
console.log('🤖 Iniciando teste do Agente Marlie...');

// Simulação simples sem dependências externas

// Mock simples do Redis
class MockRedis {
  constructor() {
    this.data = new Map();
    this.ttls = new Map();
  }

  async get(key) {
    const ttl = this.ttls.get(key);
    if (ttl && Date.now() > ttl) {
      this.data.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.data.get(key) || null;
  }

  async set(key, value, mode, duration) {
    this.data.set(key, value);
    if (mode === 'EX' && duration) {
      this.ttls.set(key, Date.now() + duration * 1000);
    }
    return 'OK';
  }

  async del(key) {
    const existed = this.data.has(key);
    this.data.delete(key);
    this.ttls.delete(key);
    return existed ? 1 : 0;
  }

  async keys(pattern) {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return Array.from(this.data.keys()).filter(key => regex.test(key));
  }

  async exists(key) {
    return this.data.has(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    if (this.data.has(key)) {
      this.ttls.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    return 0;
  }
}

// Mock simples do Database
class MockDatabase {
  constructor() {
    this.tables = new Map();
    this.tables.set('human_handoffs', []);
    this.tables.set('catalog_services', [
      {
        id: '1',
        tenant_id: 'test',
        nome: 'Corte Feminino',
        categoria: 'cabelo',
        duracao: 60,
        preco: 'R$ 80,00',
        ativo: true
      },
      {
        id: '2',
        tenant_id: 'test',
        nome: 'Manicure',
        categoria: 'unhas',
        duracao: 45,
        preco: 'R$ 35,00',
        ativo: true
      }
    ]);
  }

  async query(text, params) {
    if (text.includes('SELECT * FROM catalog_services')) {
      const services = this.tables.get('catalog_services') || [];
      return { rows: services.filter(s => s.tenant_id === 'test') };
    }
    
    if (text.includes('SELECT * FROM human_handoffs')) {
      return { rows: this.tables.get('human_handoffs') || [] };
    }
    
    return { rows: [] };
  }
}

// Mock do Trinks Service
class MockTrinksService {
  async validateAvailability(serviceId) {
    if (serviceId === '1') {
      return { available: true, confidence: 'explicit' };
    }
    return { available: false, confidence: 'ambiguous', reason: 'Serviço não encontrado' };
  }
}

async function testMarlie() {
  console.log('🤖 Testando lógica do Agente Marlie...');
  
  try {
    // Teste 1: Simulação de menu inicial
    console.log('\n📱 Teste 1: Menu inicial');
    const menuResponse = simulateMenuResponse('Oi', { first_name: 'João' });
    console.log('Resposta:', menuResponse);

    // Teste 2: Simulação de opção 1
    console.log('\n📱 Teste 2: Escolhendo opção 1');
    const option1Response = simulateOptionResponse('1');
    console.log('Resposta:', option1Response);

    // Teste 3: Simulação de serviço
    console.log('\n📱 Teste 3: Especificando serviço');
    const serviceResponse = simulateServiceResponse('Corte Feminino');
    console.log('Resposta:', serviceResponse);

    console.log('\n🎉 Simulação concluída com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro durante o teste:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Funções de simulação
function simulateMenuResponse(message, user) {
  const firstName = user?.first_name || 'Cliente';
  return `Olá ${firstName}! 👋\n\nSou a Marlie, sua assistente virtual. Como posso ajudar você hoje?\n\n*1* - 📅 Agendar serviço\n*2* - ℹ️ Informações sobre nossos serviços\n\nDigite o número da opção desejada.`;
}

function simulateOptionResponse(option) {
  if (option === '1') {
    return 'Perfeito! Vou ajudar você a agendar um serviço. 📅\n\nQual serviço você gostaria de agendar? Por exemplo:\n• Corte Feminino\n• Manicure\n• Sobrancelha\n\nOu digite o nome do serviço que procura.';
  } else if (option === '2') {
    return 'Aqui estão nossos principais serviços:\n\n💇‍♀️ **Cabelo**\n• Corte Feminino - R$ 80,00\n• Escova - R$ 45,00\n\n💅 **Unhas**\n• Manicure - R$ 35,00\n• Pedicure - R$ 40,00\n\nPara agendar, digite *1* ou me fale qual serviço te interessa!';
  } else {
    return 'Opção inválida. Por favor, escolha:\n\n*1* - Agendar serviço\n*2* - Informações\n\nDigite apenas o número.';
  }
}

function simulateServiceResponse(service) {
  const serviceLower = service.toLowerCase();
  
  if (serviceLower.includes('corte')) {
    return 'Ótima escolha! ✂️\n\n**Corte Feminino**\n💰 Valor: R$ 80,00\n⏱️ Duração: 60 minutos\n\nPara confirmar o agendamento, preciso que você:\n\n1️⃣ Escolha a data e horário\n2️⃣ Confirme seus dados\n\nQual data você prefere? (ex: amanhã, sexta-feira, 15/01)';
  } else if (serviceLower.includes('manicure')) {
    return 'Perfeito! 💅\n\n**Manicure**\n💰 Valor: R$ 35,00\n⏱️ Duração: 45 minutos\n\nPara agendar, me informe:\n\n📅 Que dia você prefere?\n🕐 Qual horário é melhor para você?';
  } else {
    return 'Hmm, não encontrei esse serviço específico. 🤔\n\nNossos serviços disponíveis:\n• Corte Feminino\n• Manicure\n• Sobrancelha\n• Escova\n\nPoderia escolher um destes ou me dar mais detalhes sobre o que procura?';
  }
}

// Executa o teste
testMarlie();