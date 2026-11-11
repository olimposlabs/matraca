# F08 — revisão independente do processamento simulado

Escopo examinado no backend inicial da fase, commit `363e68c`, e nos ajustes posteriores descritos abaixo: rotas de avaliação, contrato e validador do provedor, worker, migração008, autenticação transacional e integração com a carteira. O revisor implementou os ajustes de contexto e as regressões após autorização do responsável pela fase. Esta leitura não declara concluída a interface nem os gates remotos.

## Resultado observado

Na primeira rodada, foram executados `tests/evaluations.test.ts`, `tests/evaluation-provider.test.ts`, `tests/wallet.test.ts` e `tests/identity.test.ts`: 59 testes passaram. Após acrescentar cinco regressões e completar o contexto pedagógico, os dois arquivos de avaliação passaram com 17 testes; TypeScript e lint dos arquivos alterados passaram. Os testes usam schemas e dados sintéticos isolados. Não houve alteração de banco da demonstração nesta revisão.

Não foi identificado bloqueio de isolamento ou consistência financeira no código examinado. A criação valida autoria da gravação e disponibilidade da atividade, preserva contexto/rubrica e insere reserva, pedido, job e outbox na mesma transação. O identificador de idempotência fica limitado ao aluno e à organização; alterações de gravação ou cenário técnico com a mesma chave são rejeitadas. Pedidos concorrentes do mesmo aluno são serializados, com revalidação da sessão depois da espera.

Workers usam `FOR UPDATE SKIP LOCKED` e um token de lease. A finalização só aceita o token ainda atual. Sucesso grava relatório e consumo na mesma transação; falha definitiva e cancelamento liberam a reserva. O cancelamento relê o estado após obter o lock do job, evitando decidir com a versão lida antes da espera. Resultado tardio de um pedido cancelado é descartado. A falha deliberada ao inserir relatório reverte o débito, conforme regressão executada.

O provedor devolve conteúdo identificado como simulado, determinístico para a mesma gravação/objetivo/rubrica. O validador rejeita critérios repetidos ou ausentes, duração divergente e timestamps fora do intervalo. Critérios de áudio ou vídeo ausentes ficam sem nota e sem evidência; a média ponderada é calculada pelo servidor. O preço de provedor retornado é explicitamente zero de simulação, sem alegação de custo real de IA.

Leitura de lista, detalhe e relatório verifica o escopo pedagógico atual do aluno; o cliente não recebe o snapshot de perfil pessoal inteiro. Operadores não ganham acesso implícito às rotas de aluno. O schema liga pedido, gravação, aluno, resultado e consumo por FKs compostas.

## Contexto pedagógico completado

O contexto inicial preservava objetivo pessoal, critérios, rubrica, perfil selecionado e cinco resultados recentes, mas omitia o público da gravação e o enunciado quando o aluno informava um objetivo próprio. A correção acrescenta `audienceScenario`, derivado da gravação verificada, e `activity:{title,instructionMarkdown}`, extraído da unidade na versão matriculada. Práticas livres e diagnóstico usam `activity:null`. O campo `scenario` do pedido continua identificando o cenário técnico de simulação, sem se confundir com o público.

A regressão usa objetivo pessoal diferente do enunciado e confirma que ambos, o público e a rubrica entram no snapshot. Alterar o rascunho depois do pedido não altera o contexto persistido. Não houve alteração da migração nem do algoritmo de notas sintéticas.

## Concorrência adicional verificada

Uma regressão retém a resposta do primeiro worker, expira seu lease, permite que outro worker conclua e somente então entrega o retorno antigo. O relatório aceito permanece igual e há um único consumo. Três regressões observam espera real em `pg_locks` antes de revogar sessão, suspender o aluno ou remover o papel de aluno; após liberar o lock, o pedido recebe401/403 e não cria reserva nem job. Essas verificações passaram sem precisar alterar o algoritmo de locks/leases.

O mock não lê ou interpreta a fala como uma IA real, nem valida custo ou qualidade pedagógica. Processamento solicitado antes de uma suspensão pode continuar em background; novos pedidos e leituras continuam sujeitos à sessão atual. A validação de provedor real, carga e política de retenção permanece fora desta revisão.
