# Arquitetura

## Decisão vigente

O fundador aprovou o plano em 10 de novembro de 2026 e definiu AWS como destino posterior. O desenvolvimento atual é local, sem deploy. A proposta anterior de Cloudflare foi substituída por uma base independente de seu runtime.

| Componente | Implementação em curso |
| --- | --- |
| Interface | React, React Router e Vite, estilos por variáveis CSS |
| API | Node 24 LTS, TypeScript e Fastify |
| Dados | PostgreSQL 17 local em Docker, acesso pg e migrações SQL versionadas |
| Objetos | Filesystem privado em .data/objects com streaming e leitura por faixas |
| Processamento | Jobs duráveis no banco. Worker de avaliação será implementado na fase 08 |
| Avaliação | Provedor sintético a implementar, separado das regras de crédito e persistência |
| E-mail e pagamento | Adaptadores locais nas fases correspondentes |
| Testes | Vitest, Playwright e verificações de tipos, lint e build |

A mudança evita acoplar o piloto a uma nuvem diferente da escolhida pelo fundador. Os adaptadores AWS, políticas de acesso, filas, armazenamento e banco produtivo exigirão projeto e validação próprios. Não há conta ou recurso AWS criado nesta execução.

## Fronteiras

Entradas HTTP ficam em server/app.ts e módulos registrados pela API. Configuração local, acesso transacional ao banco e armazenamento privado possuem módulos próprios. A fase 02 implementa organização resolvida pelo domínio, identidade e papéis. Escopos escolares específicos serão acrescentados na fase 04. O mesmo e-mail em organizações diferentes tem identidades e sessões independentes. Tokens são de uso único, sessões são revogáveis e o transporte de e-mail é uma caixa local privada.

O arquivo de mídia é real, e sua duração será verificada antes de qualquer reserva de créditos. O mock de IA substituirá somente a resposta externa. Regras de negócio, ledger, pedidos e resultados continuarão persistidos de verdade.

Consulte o [plano aprovado](PLANO_DE_EXECUCAO_PILOTO.md), o [registro SPI](EXECUCAO_SPI.md) e as [operações](OPERATIONS.md) para separar o que está previsto do que já foi validado.
