# Operações

O remoto é olimposlabs/matraca no GitHub. Integração usa main e trabalho usa branches codex/. O fundador autorizou PR, revisão Codex e merge. Não existe deploy nesta execução. AWS e o pipeline de deploy serão configurados posteriormente.

## Ambiente local

Node 24 LTS é a referência. `npm ci` instala versões fixadas. `npm run dev` prepara PostgreSQL via Docker Compose, migra e confere o seed antes de iniciar API e Vite. Uma DATABASE_URL explícita permite usar um banco de teste local já iniciado, como no CI. Não registrar seu valor nos logs.

O volume matraca-postgres persiste entre reinícios. Os arquivos locais ficam em .data/objects. Não executar down com remoção de volumes para resolver problemas comuns. Migrações usam transação, lock e checksum para detectar alteração indevida de migração já aplicada.

`npm run db:start`, `npm run db:migrate` e `npm run db:seed` permitem executar as etapas separadamente. Credenciais do compose são exclusivamente sintéticas e restritas ao PostgreSQL publicado no loopback local. O modo de execução rejeita APP_MODE diferente de local até existir configuração produtiva explícita.

CI executa verificações locais equivalentes, com banco de serviço e sem segredos de nuvem. Não há job de deploy. Disponibilidade de Codex Review e resultado dos checks devem ser verificados por PR.

## Preflight operacional

- Antes de mudar infraestrutura ou operar um ambiente real, confirme identidade, conta ou workspace, ambiente, região quando aplicável, diff e impacto sobre recursos persistentes.
- Deploy manual, mutação de produção, acesso a segredos e operações destrutivas exigem a autorização e o preflight aplicáveis. Commit, PR, revisão e merge não ampliam essa autorização.
- Confirme os nomes das branches antes de usá-las. Só configure deploy automático quando houver uma decisão aprovada que estabeleça esse fluxo.
- Execute somente comandos de deploy confirmados no projeto. Registre aqui os procedimentos e os filtros efetivos de CI/CD assim que existirem. Para promoção no SPI, siga o [protocolo SPI](SMART_PHASES_IMPLEMENTATION.md).
