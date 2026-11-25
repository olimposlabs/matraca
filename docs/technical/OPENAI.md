# Avaliação real com OpenAI

Em 24/11/2026, o fundador autorizou conectar a OpenAI real no ambiente local. E-mail e pagamento continuam simulados; AWS não foi provisionada. O SPI original de 14 fases permanece encerrado. Esta integração é uma ampliação posterior, sem reclassificar as validações manuais pendentes como concluídas.

## Executar

```sh
npm ci
npm run db:start
npm run db:migrate
npm run db:seed
npm run media:build
npm run media:verify
npm run dev:openai
```

O comando inicia API e Vite com `EVALUATION_PROVIDER=openai`. `npm run dev` mantém o mock como padrão para demonstração e testes. Para servir um build: `EVALUATION_PROVIDER=openai APP_PUBLIC_PORT=3001 npm start`. Reinicie a API após alterar provedor, modelos ou chave. A avaliação real exige os três limites positivos `OPENAI_24H_REQUESTS`, `OPENAI_24H_MINUTES` e `OPENAI_24H_CALLS`. O padrão de cada um é zero. Na aba **Avaliação real** das operações do backoffice, salve os limites da organização e por aluno e autorize participantes. Na carteira, a concessão do backoffice tem uma opção explícita para habilitar o lote para avaliação real.

A API usa `OPENAI_API_KEY` quando disponível no ambiente do servidor. No macOS, sem essa variável, lê o item de senha genérica do Chaves: serviço `Matraca IA DEV - OpenAI`, conta `OPENAI_API_KEY`. `OPENAI_KEYCHAIN_SERVICE` permite outro nome. O segredo fica na memória da API; não é copiado para arquivo, frontend, banco ou Git. A leitura falha de forma explícita se o item não estiver acessível. Não há fallback silencioso para avaliações simuladas. Os testes automatizados não consultam o cofre.

Os modelos são configuráveis por `OPENAI_AUDIO_MODEL` (padrão `gpt-audio-1.5`) e `OPENAI_REPORT_MODEL` (padrão `gpt-4.1-mini`). A conta precisa permitir ambos e ter saldo/cota. O endpoint é fixo em `https://api.openai.com/v1`; redirecionamentos HTTP são recusados.

## Fluxo e limites

1. O aluno confirma o aviso de envio à OpenAI antes de solicitar. A API exige a versão vigente do aviso na criação de cada pedido real. Também revalida identidade, organização, duração, limites e carteira. O modo real aceita até **300 segundos**, inclusive quando o curso prevê uma atividade mais longa.
2. Reserva, admissão no orçamento, pedido e recibo de consentimento persistem em uma transação. O recibo vincula organização, aluno, gravação, finalidade de avaliação, versão, confirmação e opção de experiência. A avaliação real reserva apenas lotes elegíveis. Compra simulada, concessões comuns e créditos anteriores à S01 seguem no saldo geral. A liquidação e o estorno preservam os lotes e a origem do crédito. Cada worker recebe pedidos do próprio provedor. Replays da mesma chave retornam o pedido original, inclusive após mudar de modo.
3. O adaptador resolve a gravação pelo pedido persistido e suas chaves de organização/aluno. FFmpeg extrai áudio mono WAV 16 kHz em blocos de até 60 segundos e até 12 quadros JPEG de no máximo 512 pixels. A entrada é copiada por stdin para o executor local com FFmpeg 8.1.3. A imagem usa Alpine fixada por digest e o binário é conferido por arquitetura. O contêiner tem raiz somente leitura, usuário sem privilégios, rede desativada e área temporária de 224 MiB. O executor recebe somente a mídia do pedido, formato, duração e modalidades. Derivados chegam por stdout com limite de tamanho e sem log do daemon Docker e a área temporária some com o contêiner. Quadros uniformes, sem variação suficiente, não são enviados como evidência visual.
4. Chat Completions recebe somente os blocos de áudio e instruções de análise vocal. Responses recebe as observações, quadros amostrados, modalidade, duração, objetivo, enunciado, rubrica e até cinco níveis recentes do mesmo aluno, organização e provedor. O backoffice pode permitir que o aluno autorize também seu nível declarado em três categorias. A interface solicita essa opção à parte. O adaptador omite profissão, metas, e-mail, identificadores internos e caminho do arquivo. A fala, as imagens e o texto livre da atividade ainda podem conter dados pessoais.
5. A resposta usa Structured Outputs. O servidor valida critérios, modalidades, intervalos e limites; calcula a nota ponderada e insere metadados de provedor/uso. Intervalos precisam coincidir com os blocos ou quadros enviados. Toda nota real exige evidência. Uma nota visual sem imagem utilizável é recusada. Sem orador observável, o modelo é instruído a deixar critérios visuais sem nota.
6. A transação final persiste relatório, consumo, progresso e outbox. Falha definitiva/cancelamento libera a reserva. A UI diferencia relatórios reais e históricos simulados, inclusive diagnóstico, mentoria e conjuntos de evolução.

Os limites contabilizam admissões e minutos arredondados na janela móvel de 24 horas, por aluno, organização e base de avaliações. Cada admissão reserva também o máximo de chamadas das tentativas previstas. Cada despacho grava recibo antes de sair e conta por 24 horas, inclusive se o resultado for incerto. Encerrar um pedido devolve capacidade ainda reservada para chamadas futuras. A mesma credencial deve operar com uma única base de orçamento. Use credencial de projeto separada se houver outra base real.

A autorização é verificada antes da preparação da mídia, antes de cada despacho e antes de gravar um resultado real. A fila confere o recibo vigente e a permissão de experiência, quando incluída. Cancelar revoga o recibo de um pedido em aberto. Suspensão, revogação do participante ou perda de acesso à atividade pode encerrar o pedido. Um despacho autorizado já registrado pode gerar custo, mesmo quando a autorização é revogada logo depois.

A preparação local é encerrada pelo executor em até 55 segundos e tem um limite adicional no processo da API. Timeout ou indisponibilidade temporária pode ser reprocessado. O prazo por tentativa real é de 240 segundos, com lease de 255 segundos; o mock conserva 8/30 segundos. Rate limit, indisponibilidade e timeout permitem até três tentativas. Credenciais inválidas, cota esgotada, mídia não decodificável ou relatório inválido encerram sem debitar créditos. O lease com token continua impedindo commits tardios e débito duplicado.

## Uso, custo e limitações

`evaluation_provider_calls` registra etapa, modelo, status HTTP, request ID e tokens retornados por chamada, inclusive quando o relatório final falha ou é cancelado. Campos ausentes ficam nulos, não são presumidos como zero. O backoffice agrega chamadas e tokens por modelo, organização, aluno, escola e período. O relatório conserva as chamadas da tentativa concluída; a tabela conserva também tentativas anteriores. Nenhum prompt, transcrição, corpo de erro ou chave é escrito nessa telemetria.

`estimatedProviderCostCents=null` significa custo monetário não calculado. A estimativa por minuto do dashboard continua uma hipótese configurável; o valor efetivamente cobrado deve ser conciliado com a OpenAI. Créditos do aluno são uma unidade distinta. Retries, falhas, cancelamentos e recuperação após queda podem gerar custo externo mesmo sem consumo de créditos. Cancelar impede a liquidação do pedido e novas chamadas entre etapas: o servidor revalida o estado e a tentativa antes de cada chamada. Isso não desfaz uma chamada já enviada. Uma queda antes de persistir telemetria também pode deixar uma chamada sem registro local.

Todas as chamadas usam `store:false` para desabilitar a persistência de respostas recuperáveis por API. A documentação oficial indica até 30 dias de logs de monitoramento de abuso para os endpoints usados, sujeitos a exceções e a controles aprovados para a conta. A configuração de retenção da conta do Matraca fica por verificar. [Controles de dados da OpenAI](https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls-per-endpoint)

A análise visual usa amostras, não vídeo contínuo. Os trechos de áudio têm até 60 segundos, sem alinhamento exato palavra a palavra. Silêncio, áudio pouco inteligível, ausência de pessoa ou enquadramento insuficiente podem resultar em critérios sem nota. A validação estrutural não comprova a correção pedagógica de cada avaliação; a calibração com professores e a homologação humana permanecem pendentes.

## Migração e reversão

Encerre os workers antigos antes de aplicar a migração 015. Ela mantém os relatórios e saldos históricos e encerra pedidos reais ainda abertos, liberando suas reservas. Os pedidos simulados continuam intactos. Para voltar ao mock, pare as instâncias reais que usam a base e execute `npm run evaluations:drain-live` com a mesma configuração de banco. O comando cancela pedidos reais pendentes, libera suas reservas e preserva recibos de despacho já registrados. Inicie o modo mock após conferir a contagem devolvida.

Antes de aplicar a migração 019, pare API e workers da base. A migração encerra pedidos reais sem recibo de consentimento, devolve as reservas, preserva os despachos e reduz o contexto de perfil já guardado. Os alunos podem criar um novo pedido após confirmar o aviso. Para reverter uma interrupção de segurança, mantenha a análise real pausada até a migração e a versão da aplicação voltarem a ser compatíveis. [Retenção local](../OPERATIONS.md#retenção-e-remoção-local)

## Verificação

`npm test` usa transporte substituto, sem chamadas externas. Cobre payloads, erro de chave/cota, falhas transitórias, ausência de evidência, isolamento de mídia/fila, lease real, replay e liberação de créditos. `npm run lint`, `npm run typecheck` e `npm run build` completam as verificações locais.

O smoke pago é opt-in, usa fala sintética local do macOS e vídeo de teste sem pessoas reais:

```sh
npm run build
npm run test:openai -- --live
```

Requer `OPENAI_SMOKE_API_KEY` de um projeto separado e com cota própria. O smoke não carrega a chave do aplicativo. Cria um schema temporário, envia WAV e MP4 pelo endpoint de upload, executa o provedor real, confere relatório/carteira/replay e a tela desktop/mobile. As evidências ficam em `.data/openai-live-smoke.json` e `.data/openai-live-report*.png`, fora do Git; banco e mídias temporários são removidos. Não roda no CI. A validação manual do fundador continua reservada ao E2E final.

Fontes oficiais consultadas: [áudio em Chat Completions](https://developers.openai.com/api/docs/guides/audio-chat-completions), [GPT Audio 1.5](https://developers.openai.com/api/docs/models/gpt-audio-1.5), [GPT 4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
