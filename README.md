# Matraca

Matraca é uma plataforma em descoberta para desenvolver oratória por meio de gravações, avaliações por IA e prática orientada. O produto atenderá usuários avulsos e organizações parceiras com experiência white label e isolamento por organização. O piloto está em execução segundo o plano aprovado.

## Desenvolvimento local

A fundação usa Node 24 LTS, React, Vite, Fastify e PostgreSQL 17. Docker precisa estar ativo para o banco. Instale as dependências com `npm ci` e inicie com `npm run dev`. O comando prepara banco e migrações e inicia web/API. As fases de produto ainda estão em implementação.

- Interface em `http://matraca.localhost:5173`.
- API em `http://127.0.0.1:3001/api/health`.
- PostgreSQL acessível somente no loopback, porta 54329, com dados em volume Docker do projeto.
- Arquivos privados em `.data/objects`, fora do Git.
- Serviços externos serão simulados. Não há deploy configurado. AWS será uma etapa posterior.

Acompanhe os gates e evidências no [registro SPI](docs/EXECUCAO_SPI.md).

## Funcionalidades locais disponíveis

Identidade independente por organização, login por link e logout, cadastro de parceiros no backoffice, preferências, marca com preview, publicação e restauração, upload de logo validado. A gestão escolar inclui escolas, pessoas, aprovação de professores, certificações, turmas, matrículas simultâneas, grupos hierárquicos, transferência e histórico. Cursos, avaliações, carteiras e cobrança continuam nas fases seguintes do plano.

O parceiro tem uma escola, três professores aprovados, seis alunos, uma turma atual, uma turma encerrada e grupos de estado, cidade, unidade e turma. Administradores e gestores usam `/admin/education`; professores usam `/teacher` e alunos consultam vínculos em `/app/classes`.

## Contas de demonstração e login

O acesso usa links de uso único. Em `http://matraca.localhost:5173/login`, solicite um link para `ana@exemplo.test`. Depois execute `npm run inbox -- --email ana@exemplo.test --host matraca.localhost` e abra o link local recebido. O e-mail é simulado, enquanto a sessão é real e pertence somente ao host usado.

No parceiro, use `http://parceiro.matraca.localhost:5173/login`. Estão disponíveis `ana@exemplo.test`, `admin@parceiro.test`, `escola@parceiro.test` e `professor1@parceiro.test`. No backoffice, use `http://backoffice.matraca.localhost:5173/login` com `operador@matraca.test`. Filtre a inbox pelo host correspondente para evitar confundir mensagens do mesmo e-mail.

As mensagens ficam em arquivos privados, fora do Git e fora do acesso HTTP do Vite. Não há endpoint público que entregue tokens. Somente dados sintéticos devem ser usados neste piloto local.

## Documentação

- [Plano aprovado de execução do piloto](docs/PLANO_DE_EXECUCAO_PILOTO.md)
- [Plano de ensino detalhado e contexto do piloto](docs/PLANO_DE_ENSINO.md)
- [Créditos, pacotes, recompensas e cobrança](docs/CREDITOS_E_COBRANCA.md)
- [Guia para agentes e mapa de leitura](AGENTS.md)
- [Padrões de engenharia](docs/ENGINEERING.md)
- [Arquitetura e decisões técnicas](docs/ARCHITECTURE.md)
- [Operação e entrega](docs/OPERATIONS.md)
- [Estratégia de testes](docs/TESTING.md)
- [Riscos e dívida técnica](docs/TECH_DEBT.md)
- [Protocolo Smart Phases Implementation](docs/SMART_PHASES_IMPLEMENTATION.md)
