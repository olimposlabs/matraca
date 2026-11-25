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

## Retenção e remoção local

| Dados | Prazo do piloto | Tratamento |
| --- | --- | --- |
| Gravações brutas | 30 dias da criação | Aposentar, retirar acesso e excluir o objeto após o último pedido ativo |
| Áudio e quadros derivados | Durante a avaliação | Encerrar o contêiner e seu volume temporário. Manter os derivados em memória durante o uso |
| Link e arquivo da caixa local | 24 h após a expiração | Remover os arquivos e o token expirado |
| Relatório, contexto, objetivo, arquivos internos de metadados e conteúdo de mentoria | 365 dias | Remover o conteúdo e conservar as referências pedagógicas e financeiras |
| Trilha de leituras sensíveis | 90 dias | Excluir registros fora da janela |
| Cópias operacionais novas | Até 30 dias | Inventariar no ambiente, proteger e expirar por tarefa de backup do operador |

Execute a simulação diária no perfil local com a configuração do banco e do storage correspondente. O comando lê a seleção e exibe contagens e um hash, sem imprimir dados pessoais. O time operacional confirma a seleção antes de aplicar. O comando que altera os dados usa o papel de migração.

```sh
npm run privacy:retention
npm run privacy:retention -- --apply <hash-da-simulação>
```

Para pedido de remoção, use `--org <uuid>` nos dois comandos e acrescente `--student <uuid>` para selecionar um único aluno. A rotina suspende o escopo, encerra os pedidos em aberto, libera as reservas, apaga o conteúdo abrangido e desidentifica as contas. Preserva identificadores contábeis, recibos e movimentos. A remoção abrange os dados desta tabela e o perfil local. A organização inteira exige confirmação da seleção, inclusive quando contém uma única escola.

Se a execução for interrompida, gere uma nova simulação para a mesma seleção. A mídia aposentada fica sem acesso e os objetos que faltam podem ser removidos na retomada. Mantenha cópias locais protegidas e teste a restauração sintética. Um backup anterior pode conter dados já removidos. Restaure-o isoladamente, reaplique as remoções registradas e só então retome acesso. O expurgo da mídia no aplicativo abrange o storage selecionado. Cópias legadas e o tratamento do provedor seguem seu próprio ciclo. [Retenção no provedor](technical/OPENAI.md#uso-custo-e-limitações)

O endpoint de auditoria `GET /api/backoffice/ops/:orgId/sensitive-access` expõe ao operador os 100 eventos recentes do escopo. Registra ação, ator, alvo disponível, motivo fixo, resultado e data. Pedidos repetidos de um mesmo evento compartilham uma janela de dez minutos.

## Transição do banco local

A instância nova tem volume e porta próprios. Os sandboxes novos usam `.data/sandboxes-v2`. O código preserva a pasta dos sandboxes legados para que a recuperação possa ser validada antes da transferência. A verificação `npm run test:database` prepara dois bancos sintéticos, restaura um backup, reaplica grants, valida os dados com a conexão restrita e ensaia a rotação. Para dados existentes, preserve o ambiente anterior até validar backup, restauração, migração e acesso com o papel novo. Encerre o acesso antigo após conferir a cópia, conforme o uso autorizado do ambiente. Use somente a conexão restrita durante avaliações reais. O faturamento consulta transações pendentes da API e do worker no mesmo papel. Para rotacionar a credencial de runtime do ambiente principal, encerre seus processos, use `npm run db:start -- --rotate-runtime` e inicie novamente. O comando grava a nova senha no banco e no arquivo privado e retoma a rotação se for interrompido.

## Proteção do navegador e dos insumos

O documento compilado usa CSP, bloqueio de enquadramento e scripts da própria origem. As diretivas permitem os estilos da marca, mídia privada e prévias locais por blob. No Vite, o hash do preâmbulo React permite a atualização durante o desenvolvimento, com WebSocket do host local. `npm run test:web-security` verifica os cabeçalhos do build e a conexão de HMR no Chromium após compilar.

O CI executa `npm run security:check` antes da instalação. A rotina exige Actions por SHA e imagens por digest, consulta os advisories do lockfile e examina somente o índice do Git com Gitleaks. Falha de consulta e alerta detectado aparecem com mensagens distintas. O scanner roda em contêiner sem rede e com os arquivos versionados montados para leitura. A etapa de mídia verifica o FFmpeg 8.1.3 e o checksum nativo no executor fixado. [Executor de mídia](technical/OPENAI.md#fluxo-e-limites)

A exceção em `.gitleaks.toml`, registrada pela engenharia do Matraca em 25/11/2026, abrange o digest público exato usado para rejeitar a credencial de demonstração aposentada em `server/db-runtime.ts`. A exceção termina quando esse bloqueio for removido e deve ser revista na próxima atualização do scanner. [Configuração de exceções no Gitleaks](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md#configuration)

Para atualizar um insumo, confirme SHA ou digest na origem, registre a versão, execute a verificação nativa e repita o CI. A reversão usa o último insumo verificado. O build pode revisar uma diretiva para recuperar um fluxo, mantendo o bloqueio de frames.
