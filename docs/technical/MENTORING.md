# Mentorias, revisão humana e plano individual — F10

Estado: backend, interface e 21 testes PostgreSQL locais implementados. A integração global de rotas e a validação E2E estão pendentes. A validação feita pelo autor do módulo não substitui a revisão independente da fase.

## Permissões e integridade

Leituras seguem o escopo atual de `assertStudentScope`: o próprio aluno, professor aprovado/atribuído, gestor da escola atual e administrador da organização. Transferência ou revogação retiram acesso do antigo responsável, mesmo quando ele é autor do registro histórico. Operador não recebe acesso implícito aos registros pedagógicos.

Somente professor aprovado, vinculado à escola e atribuído à turma ativa do aluno pode assinar mentoria ou revisão humana. Administradores e gestores podem ler e administrar o plano dentro de seu escopo, com autoria registrada sob seu próprio papel. Acumular o papel de aluno não concede poder de gerir o próprio plano ou assinar mentoria sem vínculo docente real.

Mutações usam lock educacional por organização (`hashtextextended(orgId,4)`), seguido de `requireIdentity(request,roles,client)` e conferência atual do vínculo. Logout, perda de papel e suspensão de aprovação enquanto o pedido aguarda impedem o registro. Não há operação de carteira neste módulo.

Mentorias e revisões humanas são append-only, com autoria e data. Correção cria novo registro com `supersedesId`, apontando para registro do mesmo professor/aluno e, para revisão, da mesma avaliação. O original permanece acessível. O relatório IA não é atualizado pela revisão humana.

O plano guarda o estado atual e uma fotografia de cada revisão, incluindo autor, papéis, resposta e data. Alterações exigem `expectedRevision`; concorrência retorna `409`. O aluno pode alterar apenas o próprio progresso (`planned`, `in_progress`, `completed`) e escrever uma resposta. Não altera título, descrição, prazo ou cancelamento. Um item cancelado pelo responsável não pode ser reaberto pelo aluno.

## Contratos HTTP

Todos os caminhos abaixo usam o prefixo `/api/mentoring`. Mutação exige os controles de sessão/origem já existentes. Corpo é JSON estrito. As listas devolvem `{items,total,page,pageSize}` e aceitam `page`/`pageSize`, máximo 100. Datas de calendário usam `YYYY-MM-DD`; instantes usam ISO com fuso.

| Método e caminho | Comportamento |
| --- | --- |
| `GET /students` | Painel docente/gestor paginado, busca `search`, alunos autorizados com `lastMentoringAt`, `pendingItems`, `latestLevel` |
| `GET /students/:id` | `{student:{id,name,email,profile},permissions:{authorTeacher,managePlan,ownProgress}}` |
| `GET /students/:id/sessions` | Histórico paginado de mentorias, com autor e correções |
| `POST /students/:id/sessions` | Registra mentoria; `201 {session}` |
| `GET /students/:id/reviews` | Revisões humanas paginadas, com `source:'human'` |
| `POST /evaluations/:id/reviews` | Registra apreciação da avaliação concluída; `201 {review}` |
| `GET /students/:id/plan` | Itens atuais paginados do plano |
| `POST /students/:id/plan` | Cria tarefa/meta e sua primeira revisão; `201 {item}` |
| `PATCH /plan/:id` | Atualiza com revisão otimista; `200 {item}` |
| `GET /plan/:id/history` | Fotografias, respostas e autores em ordem de revisão decrescente |

Corpo de mentoria: `{clientKey,occurredAt,evaluationId?,difficulties:string[],guidance,actions:string[],followUpOn?:date|null,supersedesId?}`. Dificuldades e ações são obrigatórias. A evidência opcional referencia uma avaliação concluída do mesmo aluno.

Corpo de revisão: `{clientKey,summary,observations:[{criterionId,note,level?,startUs?,endUs?}],supersedesId?}`. `level` é inteiro 1–4 ou null. O critério precisa existir na fotografia de rubrica da avaliação. O trecho é opcional; quando informado, exige início/fim juntos, `0 <= startUs < endUs <= duração verificada`. Nível numérico em critério não observável na modalidade é rejeitado. A resposta mantém `evaluationId`, `teacherId`, resumo e observações humanas, separadamente do relatório IA.

Criação de plano: `{clientKey,kind:'task'|'goal',title,description?,dueOn?:date|null,mentoringSessionId?}`. O vínculo opcional precisa pertencer ao mesmo aluno. Atualização: `{expectedRevision,title?,description?,dueOn?,status?,response?}`; pelo menos uma mudança além da revisão é necessária. `dueOn:null` remove prazo. Os estados são `planned`, `in_progress`, `completed`, `cancelled`; as restrições do aluno descritas acima são verificadas no servidor.

Criações usam `clientKey` UUID por intenção. Reenvio pelo mesmo autor devolve o registro existente, depois de revalidar autorização. Reutilizar a chave com outros dados retorna `409`. Atualizações do plano usam CAS e não duplicam uma revisão em retry com `expectedRevision` antigo; a interface deve recarregar para resolver o conflito.

Registro de mentoria retorna `id,studentId,teacherId,occurredAt,evaluationId,difficulties,guidance,actions,followUpOn,supersedesId,createdAt`. Listas acrescentam `teacherName`. Item de plano retorna `id,studentId,createdBy,kind,title,description,status,dueOn,mentoringSessionId,revision,createdAt,updatedAt`. Histórico retorna `revision,snapshot,response,actorId,actorRoles,actorName,createdAt`.

O player usa `/api/recordings/:recordingId/media` a partir da avaliação consultada em `/api/evaluations/:id`. Não se introduz URL pública de arquivo. O frontend converte segundos de edição para microssegundos e usa os limites verificados informados pela avaliação.

## Interface e integração

`client/mentoring.tsx` exporta `MentoringPage` com `view='student'|'teacher'|'manage'`. O componente inclui seu próprio `AuthenticatedArea`; `mentoring.css` tem seletores próprios e usa as variáveis de branding existentes. Nenhuma edição global de `App.tsx` ou `auth.tsx` foi feita neste módulo.

Rotas sugeridas para a integração: `/app/mentoring` com `view='student'`, `/teacher/mentoring` com `view='teacher'`, `/admin/mentoring` com `view='manage'`. Acrescentar os links na navegação correspondente ao papel, preservando o guard do servidor.

A tela de aluno abre seu próprio plano. Professor/gestor busca alunos autorizados e abre quatro seções paginadas: plano, mentorias, revisões humanas e avaliações. As permissões retornadas pelo backend determinam as ações. Formulários usam diálogo nativo com foco e bloqueio de fechamento durante envio. Conflito de revisão preserva os campos locais e oferece recarga explícita; respostas digitadas são mantidas na recarga.

Mentoria pode ser registrada a partir de uma avaliação para vinculá-la como evidência. Correção abre novo registro com referência ao anterior. A tela de revisão mantém player privado e relatório original de IA identificado como simulado, separado da apreciação humana. Permite múltiplas observações, critério, nível opcional e trechos; o instante atual pode preencher o início e trechos registrados podem reposicionar o player. O histórico do plano mostra fotografia, autor e resposta em cada revisão.

## Persistência e evidência

Migração `010_mentoring.sql`: `mentoring_sessions`, `human_reviews`, `individual_plan_items`, `individual_plan_history`. Chaves compostas impedem referências a aluno/organização alheios. Triggers protegem mentorias, revisões humanas e histórico do plano contra UPDATE/DELETE.

`tests/mentoring.test.ts`: **21 testes passaram** em schema e armazenamento exclusivos, sem alterar demonstração. Cobrem painel/escopo, idempotência concorrente, append-only, correção de mentoria, critério/tempo/modalidade, conservação do relatório IA e saldo, progresso/resposta do aluno, CAS concorrente, papéis cumulativos, referências cruzadas, transferência, quatro revogações e três cenários de revogação durante espera. TypeScript e lint passaram.

Fixtures de avaliações são sintéticas e válidas para o contrato de persistência; não afirmam medir oratória real. O módulo não cria nova avaliação, nova cobrança ou prêmio. A integração da jornada F09 e a validação visual/E2E, revisão independente, CI e SHA final permanecem pendentes.
