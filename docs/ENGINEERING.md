# Engenharia

Estas diretrizes se aplicam à medida que o Matraca ganhar código. A stack e os padrões específicos de linguagem estão **A definir**.

## Mudanças e responsabilidades

- Preserve arquitetura, contratos e comportamento existentes. Prefira mudanças pequenas, incrementais, compatíveis e reversíveis. Separe refatorações amplas de correções pontuais.
- Separe entrada e transporte, aplicação, domínio, persistência e integrações conforme a complexidade real. Mantenha regras de negócio fora de handlers, controllers e arquivos de infraestrutura. Documente as fronteiras implementadas em [Arquitetura](ARCHITECTURE.md).
- Use nomes claros, funções com propósito definido e efeitos externos explícitos. Centralize configuração, mensagens, prompts e classificação de erros externos quando existirem. Evite duplicação, abstrações prematuras e dependências sem justificativa.
- Planeje migração e rollback antes de mudar contratos, dados persistidos ou a identidade de recursos com estado.

## Segurança e resiliência

- Preserve autenticação, autorização, validação de entradas, privacidade, isolamento conforme o modelo de dados e menor privilégio. Falhe de modo seguro quando faltarem credencial, configuração crítica ou condição de autorização. Só trate como sucesso o que puder confirmar.
- Use idempotência quando eventos, webhooks, mensagens ou comandos puderem se repetir. Defina timeouts, tentativas limitadas e tratamento seguro de falhas nas integrações externas.
- Mantenha `.env`, segredos, tokens, dados reais de clientes, caches, builds e artefatos gerados fora do Git. Use placeholders em exemplos. Documente apenas nomes e finalidade das variáveis.

## Validação e documentação

- Ao alterar comportamento, siga a [estratégia de testes](TESTING.md). Se houver monorepo, respeite as fronteiras entre produtos e rode comandos a partir do diretório do manifesto correspondente.
- Atualize as fontes de verdade sobre comportamento, endpoints, configuração, deploy, operação, testes, decisões e dívida conforme o diff. Confira se as afirmações antigas ainda descrevem o comportamento efetivo, além de validar os links.
