# Arquitetura

## Decisão vigente

O fundador aprovou o plano em 10 de novembro de 2026 e definiu AWS como destino posterior. O desenvolvimento atual é local, sem deploy. A proposta anterior de Cloudflare foi substituída por uma base independente de seu runtime.

| Componente | Implementação local |
| --- | --- |
| Interface | React, React Router e Vite, estilos por variáveis CSS |
| API | Node 24 LTS, TypeScript e Fastify |
| Dados | PostgreSQL 17 local em Docker, acesso pg e migrações SQL versionadas |
| Objetos | Filesystem privado em .data/objects com streaming e leitura por faixas |
| Processamento | Jobs e outbox duráveis no banco, worker local com lease e recuperação |
| Avaliação | Provedor sintético, separado das regras de crédito e persistência |
| E-mail e pagamento | Caixa de e-mail local e eventos idempotentes de pagamento simulado |
| Testes | Vitest, Playwright e verificações de tipos, lint e build |

A mudança evita acoplar o piloto a uma nuvem diferente da escolhida pelo fundador. Os adaptadores AWS, políticas de acesso, filas, armazenamento e banco produtivo exigirão projeto e validação próprios. Não há conta ou recurso AWS criado nesta execução.

## Fronteiras

Entradas HTTP ficam em server/app.ts e módulos registrados pela API. Configuração local, acesso transacional ao banco e armazenamento privado possuem módulos próprios. A fase 02 implementa organização resolvida pelo domínio, identidade e papéis. A fase 04 acrescenta escolas, turmas, vínculos históricos e grupos, com autorização centralizada em server/permissions.ts. Mutações educacionais revalidam a sessão dentro da transação depois de adquirir o lock da organização. O mesmo e-mail em organizações diferentes tem identidades e sessões independentes. Tokens são de uso único, sessões são revogáveis e o transporte de e-mail é uma caixa local privada.

O arquivo de mídia é real. O servidor verifica formato e duração e autoriza reprodução por faixa. A avaliação reserva créditos antes de enfileirar. Sucesso grava relatório, liquida a reserva e conclui o progresso na mesma transação. Falha definitiva e cancelamento liberam a reserva. Mentorias, revisões humanas e histórico do plano têm autoria própria.

Versões publicadas de cursos e snapshots de faturas preservam as condições aplicadas. Eventos de aprendizado mantêm o grupo vigente no momento da atividade. Créditos, compras e fechamento têm chaves idempotentes. A composição de eventos e adaptadores locais preserva pontos de integração para o futuro desenho serverless na AWS.

Consulte o [plano aprovado](PLANO_DE_EXECUCAO_PILOTO.md), o [registro SPI](EXECUCAO_SPI.md) e as [operações](OPERATIONS.md) para separar o que está previsto do que já foi validado.
