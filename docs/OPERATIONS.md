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

## Interface compilada

Depois de `npm run build`, `APP_PUBLIC_PORT=3001 npm start` serve API e interface na porta3001. O servidor local deve estar livre nessa porta; encerre a execução dev correspondente antes de usar esse modo. A porta pública orienta os links da mailbox. A rota de frontend não converte caminhos /api inexistentes em HTML.

O modo dev usa Vite em5173 e API em3001. O Vite permite apenas os diretórios públicos necessários e nega dados privados, inclusive /@fs e importações raw. A inbox é consultada por `npm run inbox`, com filtros --email e --host.

## Sandbox com dados separados

```sh
npm run pilot:sandbox -- start --name revisao --port 5174 --examples
```

O sandbox cria um schema, uma pasta de mídia, uma mailbox e um build separados. O terminal mostra os endereços, que incluem um identificador do diretório de trabalho para separar sessões entre checkouts. Use o host mostrado para solicitar o link e a pasta do sandbox na consulta.

```sh
STORAGE_ROOT=.data/sandboxes/revisao/objects npm run inbox -- --email ana@exemplo.test
```

Encerre a execução com Ctrl+C para liberar o lock. O comando abaixo apaga apenas o sandbox com o nome confirmado. Reiniciar com o mesmo nome retoma os dados existentes.

```sh
npm run pilot:sandbox -- reset --name revisao --confirm revisao
```

A operação cotidiana, os cenários locais e o fechamento sob demanda estão descritos em [Console de operações](technical/OPERATIONS_CONSOLE.md).
