# Gravações privadas — backend F07

`server/recordings.ts` implementa o envio de arquivos reais, a verificação de duração e formato, a associação à atividade e a reprodução autorizada. O navegador é responsável pela captura com microfone/câmera, preview, descarte antes do envio, escolha de dispositivos, progresso e cancelamento. A origem declarada `capture` ou `upload` serve como metadado; ambas passam pela mesma validação no servidor.

## Fluxo e limites

1. O aluno consulta as restrições da atividade e prepara uma gravação ou seleciona um arquivo.
2. Envia um multipart com `metadata` JSON primeiro e um único arquivo no campo `file` depois.
3. O servidor autentica o aluno, resolve sua matrícula e versão e grava em filesystem privado por streaming. Arquivo parcial usa nome temporário e somente é renomeado ao concluir o stream.
4. `probeMedia` lê o container e todos os pacotes codificados com limites de recursos, medindo a duração de apresentação em microssegundos. Não utiliza extensão, MIME declarado ou duração enviada pelo navegador como autoridade.
5. Após obter o lock da organização, o servidor revalida sessão, expiração, host, revogação, papéis, status e configuração da atividade; só então insere o registro e a auditoria em uma transação.
6. A resposta inclui duração verificada e estimativa de créditos. Não reserva nem consome créditos. Essa operação pertence ao pedido de avaliação daF08.

O limite de arquivo é200 MiB. Os containers aceitos são MP4, WebM, WAV e MP3. Gravação livre aceita áudio ou vídeo de até300 segundos e exige objetivo. Diagnóstico aceita até30 segundos e respeita `diagnosticEnabled`; o objetivo padrão descreve a comunicação inicial. Atividades de curso derivam limite, tipos de mídia e cenário da unidade publicada, até1800 segundos conforme o editor. Nenhuma tolerância implícita amplia o limite de duração.

Mídia com faixa de vídeo é classificada como vídeo, mesmo que também tenha áudio. Sem faixa de vídeo, é classificada como áudio. O parser pode aceitar vídeo sem som; `hasAudio` e `hasVideo` ficam explícitos para que a avaliação trate critérios não observáveis corretamente. O parser verifica estrutura e disponibilidade dos pacotes; não afirma decodificação completa ou qualidade pedagógica do conteúdo. Os detalhes do probe estão em `MEDIA_PROBE.md`.

Uma atividade de curso exige matrícula do próprio aluno, não cancelada, e unidade existente na versão matriculada. Uma matrícula concluída permite nova prática na mesma versão. Publicar uma versão nova não muda a associação da gravação. `coursesEnabled:false` impede novos envios para atividades de curso; avaliação livre permanece disponível. A gravação preserva cenário e limite aplicados, além da versão e unidade. Regras de desbloqueio por progresso são integradas pela fase de jornada, não inferidas a partir da ordem visual do editor nesta fase.

## Privacidade e persistência

O objeto fica em `recordings/{orgId}/{studentId}/{recordingId}`, dentro do storage privado. O cliente não escolhe chave, organização ou aluno. A tabela `recordings` guarda metadados verificados e o resultado interno do probe; as respostas públicas não expõem a chave nem esse objeto técnico.

Fks compostas vinculam gravação, aluno, organização, matrícula e versão. A migração007 acrescenta a unicidade composta necessária em `course_enrollments` para impedir associação à versão de outra matrícula. `UNIQUE(id,org_id,student_id)` em gravações permite a referência do pedido de avaliação daF08.

Erros de upload, truncamento, limite, formato, revalidação ou persistência removem o objeto recém-criado. O storage remove o arquivo temporário quando o stream falha ou é interrompido. Cancelar depois de um commit concluído pode deixar uma gravação válida registrada mesmo que o cliente não tenha recebido a resposta; isso não gera cobrança. Um encerramento abrupto do processo entre gravação do objeto e transação pode deixar objeto órfão privado: a limpeza operacional deve reconciliar objetos sem registro, sem apagar arquivos referenciados. Não se afirma atomicidade entre filesystem e PostgreSQL.

Upload é exclusivo do aluno para si. Listagem, detalhe e download usam o mesmo escopo pedagógico dos relatórios: aluno próprio, administrador da organização, gestor da escola atual ou professor aprovado e atualmente atribuído. Uma transferência de escola revoga o acesso da escola/professor anterior também ao arquivo histórico. Operador não recebe acesso implícito por esses endpoints; ferramentas centrais futuras precisam autorização específica.

Downloads privados usam `streamPrivateFile`, com faixa única, suporte a busca temporal, `Content-Length`, `Content-Range`, `nosniff`, `no-store` e CSP restritiva. A autorização é refeita a cada pedido, inclusive de faixa. Nenhuma URL pública permanente é gerada.

## Contrato HTTP

| Método e caminho | Entrada | Resposta |
| --- | --- | --- |
| `GET /api/recordings/options` | `purpose`; para curso, `enrollmentId` e `unitId` | `{constraints:{maximumBytes,maximumSeconds,acceptedMedia},scenario,unit:{id,title}|null}` |
| `POST /api/recordings` | Multipart `metadata` JSON seguido de `file` | `201 {recording}` |
| `GET /api/recordings` | `page=1`, `pageSize=20` até100, `purpose?`, `studentId?` | `{items,total,page,pageSize}` |
| `GET /api/recordings/:id` | Identificador da gravação | `{recording}` |
| `GET/HEAD /api/recordings/:id/media` | `Range: bytes=...` opcional | Arquivo autorizado,200 ou206; faixa inválida416 |

`metadata` aceita estritamente:

```json
{
  "purpose": "free",
  "objective": "Apresentar minha proposta com clareza.",
  "scenario": "executive",
  "source": "upload"
}
```

`purpose` pode ser `free`, `diagnostic` ou `course`; `source`, `upload` ou `capture`. Para curso, enviar `enrollmentId` e `unitId`; `objective` é opcional e usa o enunciado da unidade como padrão. Cenários são `one_on_one`, `executive` e `audience`. Curso utiliza o cenário configurado na unidade; os demais usam a escolha enviada ou `one_on_one`. Não são aceitos `studentId`, `orgId`, `versionId`, duração, saldo ou chave de objeto no corpo.

`recording` contém `id,studentId,filename,mimeType,byteLength,durationMicroseconds,hasAudio,hasVideo,objective,purpose,enrollmentId,versionId,unitId,scenario,maximumSeconds,source,createdAt,estimatedCredits`. Créditos estimados usam a mesma função inteira da carteira, com arredondamento por minuto para cima. Não confirmam saldo suficiente para um pedido posterior.

A listagem sem `studentId` usa o próprio aluno. Gestores e professores devem indicar o aluno autorizado. Os registros são ordenados por criação decrescente e identificador; os filtros são aplicados no banco.

Falhas: campos/multipart inválidos ou mídia truncada400; sessão revogada401; papel, vínculo ou funcionalidade indisponível403; recurso fora do tenant ou atividade não encontrada404; arquivo maior que200 MiB413; formato ou modalidade não aceita415; limite de duração/complexidade422. Todas as mutações seguem o header `x-matraca-request:1` e a proteção de origem da aplicação.

## Integração interna

`registerRecordings(app)` registra as rotas. `StoredRecording` representa o registro interno, com campos `snake_case` e BIGINT recebidos como string do PostgreSQL. `loadRecording(client,orgId,id)` faz apenas a busca no tenant; o chamador precisa autorizar o aluno separadamente. `requireRecordingScope(request,id)` valida a sessão e o escopo pedagógico atual, retornando `{actor,recording}`. `publicRecording` remove detalhes de armazenamento e calcula a estimativa.

Os testes de integração da fase usam schema PostgreSQL e diretório temporário isolados. Captura real do Chromium e fixtures de áudio/vídeo verificam o caminho completo, além do parser isolado. A evidência final de testes e limites remanescentes pertence a `PHASE07_REVIEW.md` e aos gates da fase; este documento não declara concluída a interface de captura ou a avaliação por IA.
