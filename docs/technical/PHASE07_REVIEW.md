# F07 — revisão independente de gravações e acesso à mídia

Revisão do backend no worktree da fase 07. Foram examinados `server/recordings.ts`, `server/migrations/007_recordings.sql`, armazenamento, streaming privado, integração com cursos e autorização escolar. A evidência executável está em [recordings.test.ts](../../tests/recordings.test.ts).

## Isolamento e validação local

A suíte cria schema PostgreSQL aleatório e armazenamento temporário próprios. Aplica as migrações nesse schema, cria apenas identidades sintéticas e remove seus recursos ao terminar. Não modifica o seed da demonstração.

FFmpeg gera arquivos MP4 e WAV sintéticos. A captura WebM vem da fixture existente produzida por `MediaRecorder` real do Chromium sobre um canvas sintético; este teste verifica seu upload e persistência. Não se trata de uma nova captura de câmera no navegador nesta suíte.

Node `24.22.2`, Vitest `4.1.12`, PostgreSQL 17: **27 testes passaram, sem skips**. TypeScript, lint da suíte e `git diff --check` passaram.

| Área | Resultado observado |
| --- | --- |
| MP4 | Upload persiste bytes originais, duração verificada, autoria, auditoria e permissão de arquivo `0600` |
| MIME | Conteúdo real prevalece sobre extensão e MIME informados; resposta preserva o tipo verificado com codecs |
| Captura e áudio | WebM real de `MediaRecorder` sem duração global e WAV somente de áudio são aceitos e medidos |
| Privacidade | Resposta pública não inclui chave do objeto nem estrutura interna do probe |
| Créditos | Upload não cria carteira nem reserva/consumo; informa apenas estimativa pelo tempo verificado |
| Opções | Livre informa 300 segundos e diagnóstico 30, sem exigir curso ou saldo; livre exige objetivo |
| Limite de tempo | Cinco minutos exatos são aceitos; fração seguinte é rejeitada; diagnóstico rejeita 30,001 segundos |
| Mídia inválida | Arquivo vazio, conteúdo incompatível e MP4 truncado são rejeitados sem registro ou objeto remanescente |
| Multipart | Metadata precisa preceder o arquivo; campos de organização, aluno, duração e limite não são aceitos do cliente |
| Curso | Matrícula e versão atribuídas determinam unidade, limite, objetivo padrão, modalidade e cenário; outra matrícula/unidade é rejeitada |
| Modalidade | Atividade somente de áudio rejeita vídeo; duração da unidade é verificada no servidor |
| Flags | Desligar curso ou diagnóstico impede a jornada correspondente e conserva gravação livre |
| Matrícula | Cancelamento impede novo envio; matrícula concluída conserva acesso à versão atribuída |
| Listagem | Paginação e filtro de propósito conservam o escopo de um aluno; outro aluno não consulta a lista alheia |
| Streaming | Bytes completos, prefixo e sufixo correspondem ao objeto; ranges inválidos/múltiplos retornam `416` |
| Autorização | Metadados e mídia exigem sessão; outro aluno recebe `403`, outro tenant `404`; professor precisa de aprovação e atribuição |
| Transferência | Antigo gestor/professor perde lista, metadados e mídia; o próprio aluno conserva o arquivo |
| Autoria | Professor e operador não enviam em nome de aluno |
| Banco | Referência composta rejeita associar a gravação à matrícula/versão de outro aluno |
| Persistência | Recriar a aplicação sobre o mesmo banco/armazenamento conserva metadados e bytes reproduzíveis |
| Fila transacional | Desativar cursos enquanto a finalização aguarda o lock impede persistência e remove o objeto já recebido |
| Revogação durante envio | Logout, suspensão, perda de papel, diagnóstico desativado e matrícula cancelada após o início do upload impedem a finalização |
| Interrupção | Desconexão real do cliente remove o arquivo temporário, sem registro no banco |
| Tamanho | Um stream HTTP de 200 MiB mais um byte retorna `413` e deixa armazenamento e banco sem artefatos |

Os testes de revogação durante upload usam servidor HTTP em porta efêmera no loopback. Enviam parte do arquivo, observam a criação do temporário e só então alteram o estado autorizado antes de concluir o envio. O teste de fila observa a espera real em `pg_locks` antes de modificar a flag e liberar a transação. Nenhum desses casos depende apenas de um atraso presumido.

## Achados tratados

1. O INSERT de auditoria referenciava `event`, mas a tabela usa `event_type`. Isso impediria a conclusão de uploads válidos. A coluna foi corrigida; a regressão positiva confirma registro e auditoria junto do objeto. O erro foi encontrado por leitura, antes da execução da suíte.
2. O diagnóstico inicialmente ignorava `org.settings.diagnosticEnabled`. O guard foi incorporado ao contexto comum de opções, início do upload e revalidação final. Testes comprovam o bloqueio inicial e a revogação durante envio, preservando a jornada livre.

Não foram identificados achados bloqueantes pendentes no backend examinado após essas correções.

## Fronteiras verificadas e limites

O objeto recebe chave gerada pelo servidor usando organização, aluno e UUID. O nome enviado não define caminho de armazenamento. `LocalStorage.put` grava temporário privado e faz rename somente ao terminar; erro no stream remove o temporário. Falhas posteriores de probe ou autorização removem o objeto final antes de responder.

O probe inspeciona a mídia recebida; a validação de duração/modalidade ocorre antes da finalização e é conferida de novo contra o contexto atual. A transação final usa o lock por organização, revalida a sessão e o papel do aluno e relê a matrícula e as flags. Registro e auditoria são atômicos no banco. Arquivo e banco não são uma transação distribuída: encerramento abrupto do processo entre gravação do objeto e commit pode deixar objeto órfão, que exige limpeza operacional posterior.

Leitura e download usam o mesmo guard de aluno atual da gestão escolar. Os ranges são transmitidos por stream, sem autorização derivada de URL pública ou de chave enviada pelo navegador. O arquivo continua pertencendo ao aluno depois de uma transferência; o vínculo antigo da escola não concede acesso histórico à mídia individual.

Esta revisão não valida interface de seleção de dispositivos, negativa de permissão do navegador, captura ao vivo da tela F07, progresso visual ou ambientação. Essas jornadas pertencem ao E2E de frontend. Não houve teste de carga, avaliação por IA, reserva financeira ou política de retenção implementada nesta fase.

O parecer independente é favorável ao backend examinado. SHA final, CI e integração de frontend precisam ser confirmados pelo responsável pela fase antes do merge. Nenhum push, merge ou deploy foi realizado por esta revisão.
