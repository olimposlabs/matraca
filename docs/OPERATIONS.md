# Operações

O remoto é olimposlabs/matraca no GitHub. Integração usa main e trabalho usa branches codex/. O fundador autorizou PR, revisão Codex e merge. Não existe deploy nesta execução. AWS e o pipeline de deploy serão configurados posteriormente.

## Ambiente local

Node 24 LTS é a referência. `npm ci` instala versões fixadas. `npm run dev` prepara PostgreSQL via Docker Compose, migra e confere o seed antes de iniciar API e Vite. Uma `DATABASE_URL` explícita configura o papel de runtime para a API. `MATRACA_MIGRATION_DATABASE_URL` configura a conexão da CLI de migração e seed. A suíte usa `TEST_DATABASE_URL` ou o banco descartável do projeto. O CI define a conexão de testes e a de migração para seu serviço PostgreSQL efêmero.

O volume matraca-postgres persiste entre reinícios. Os arquivos da instância nova ficam em `.data/local/objects`. Não executar down com remoção de volumes para resolver problemas comuns. Migrações usam transação, lock e checksum para detectar alteração indevida de migração já aplicada.

`npm run db:start`, `npm run db:migrate` e `npm run db:seed` permitem executar as etapas separadamente. O Compose prepara uma nova instância em `127.0.0.1:54339`. `npm run db:start` cria a senha de bootstrap em arquivo privado e concede ao banco escolhido papéis distintos de migração e execução. O processo de inicialização da API recebe a conexão de execução. A CLI de migração é executada separadamente e preserva o registro de checksums. O modo de execução rejeita APP_MODE diferente de local até existir configuração produtiva explícita.

CI executa verificações locais equivalentes, com banco de serviço e sem segredos de nuvem. Não há job de deploy. Disponibilidade de Codex Review e resultado dos checks devem ser verificados por PR.

## Preflight operacional

- Antes de mudar infraestrutura ou operar um ambiente real, confirme identidade, conta ou workspace, ambiente, região quando aplicável, diff e impacto sobre recursos persistentes.
- Deploy manual, mutação de produção, acesso a segredos e operações destrutivas exigem a autorização e o preflight aplicáveis. Commit, PR, revisão e merge não ampliam essa autorização.
- Confirme os nomes das branches antes de usá-las. Só configure deploy automático quando houver uma decisão aprovada que estabeleça esse fluxo.
- Execute somente comandos de deploy confirmados no projeto. Registre aqui os procedimentos e os filtros efetivos de CI/CD assim que existirem. Para promoção no SPI, siga o [protocolo SPI](SMART_PHASES_IMPLEMENTATION.md).

## Interface compilada

Depois de `npm run build`, `APP_PUBLIC_PORT=3001 npm start` serve API e interface na porta3001. O servidor local deve estar livre nessa porta; encerre a execução dev correspondente antes de usar esse modo. A porta pública orienta os links da mailbox. A rota de frontend não converte caminhos /api inexistentes em HTML.

O modo dev usa Vite em5173 e API em3001. O Vite permite apenas os diretórios públicos necessários e nega dados privados, inclusive /@fs e importações raw. A inbox é consultada por `npm run inbox`, com filtros --email e --host.

## Sandbox com dados separados

```sh
npm run pilot:sandbox -- start --name revisao --port 5174 --examples
```

O sandbox cria um banco com credenciais próprias e uma pasta privada para mídia, mailbox e build. O terminal mostra os endereços, que incluem um identificador do diretório de trabalho para separar sessões entre checkouts. Use o host mostrado para solicitar o link e a pasta do sandbox na consulta.

```sh
STORAGE_ROOT=.data/sandboxes-v2/revisao/objects npm run inbox -- --email ana@exemplo.test
```

Encerre a execução com Ctrl+C para liberar o lock. O comando abaixo apaga o banco, os papéis e arquivos do sandbox com o nome confirmado. Reiniciar com o mesmo nome retoma os dados existentes.

```sh
npm run pilot:sandbox -- reset --name revisao --confirm revisao
```

A operação cotidiana, os cenários locais e o fechamento sob demanda estão descritos em [Console de operações](technical/OPERATIONS_CONSOLE.md).

## OpenAI real no ambiente local

Autorizada em 24/11/2026: `npm run dev:openai`, ou `EVALUATION_PROVIDER=openai` ao iniciar a API. O segredo é lido no servidor, do ambiente ou do Chaves do macOS. `npm run dev` e CI preservam o modo mock. [Operação, modelos e smoke pago](technical/OPENAI.md).

## Transição do banco local

A instância nova tem volume e porta próprios. Os sandboxes novos usam `.data/sandboxes-v2`. O código preserva a pasta dos sandboxes legados para que a recuperação possa ser validada antes da transferência. A verificação `npm run test:database` prepara dois bancos sintéticos, restaura um backup, reaplica grants, valida os dados com a conexão restrita e ensaia a rotação. Para dados existentes, preserve o ambiente anterior até validar backup, restauração, migração e acesso com o papel novo. Encerre o acesso antigo após conferir a cópia, conforme o uso autorizado do ambiente. Use somente a conexão restrita durante avaliações reais. O faturamento consulta transações pendentes da API e do worker no mesmo papel.
