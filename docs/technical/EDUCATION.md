# Gestão escolar e autorização — F04

`server/education.ts` registra `/api/education` por `registerEducation(app)`.
`server/permissions.ts` contém a política reutilizável de acesso a alunos e escolas.
A migração `004_education.sql` acrescenta as entidades escolares e `users.archived_at`.

## Modelo e fronteiras

- `schools` pertence a uma organização. Nome, cidade, estado e situação podem ser
  editados pelo administrador; arquivar não apaga a escola.
- `school_staff` vincula gestores (`school`) e professores (`teacher`) às escolas.
  Um profissional pode ter vários vínculos. `ended_at` encerra o acesso daquele
  vínculo sem apagá-lo.
- `student_schools` mantém o histórico de afiliação escolar. Um índice único parcial
  permite uma única escola atual por aluno/organização.
- `teacher_profiles` registra aprovação central e certificações. Um professor novo
  começa pendente. Aprovação pertence à organização, não ao gestor da escola.
- `classes`, `enrollments` e `teacher_class_assignments` preservam vínculos anteriores.
  Um aluno pode participar de várias turmas da escola atual simultaneamente.
- `group_types`, `education_groups` e `group_memberships` implementam classificações
  configuráveis. Um grupo pode ser organizacional ou vinculado a uma escola.
- `student_transfers` registra origem, destino, motivo e responsável pela mudança.

Chaves estrangeiras compostas vinculam cada escola, usuário, turma, grupo e vínculo
à mesma organização. Inserir uma referência de outro tenant é recusado pelo banco.
Índices parciais impedem duplicar vínculos ativos de matrícula, staff, professor
em turma, participante de grupo e afiliação escolar do aluno.

## Matriz de acesso

| Papel | Escopo |
| --- | --- |
| `org_admin` | Todas as escolas e pessoas da própria organização; criação de escolas, gestores, aprovação de professores, tipos de grupo e transferências |
| `school` | Escolas com vínculo ativo de gestor; alunos atuais e profissionais vinculados a elas; turmas e grupos dessas escolas |
| `teacher` | Próprio cadastro e alunos de turmas ativas às quais está atribuído, desde que aprovado e com vínculo ativo na escola |
| `student` | Próprio cadastro e histórico de matrículas; sem acesso aos colegas |

O operador de backoffice não recebe acesso escolar implícito. Continua em seu realm
separado; não existe impersonação ou parâmetro que transforme `operator` em gestor.

`requireStudentScope(request, studentId)` é exportado por `permissions.ts` e
reexportado por `education.ts`. Retorna a identidade autenticada após autorizar
o aluno no estado atual do banco. Identificador inválido retorna 400; aluno de
outra org ou inexistente, 404; aluno fora da atribuição, 403. Relatórios, mídia,
mentorías e carteira devem chamar essa política antes de expor dados de um aluno.

Para professores, são exigidos ao mesmo tempo: sessão e usuário ativos, papel
teacher, aprovação central, escola ativa, vínculo docente ativo, turma ativa,
atribuição ativa e matrícula ativa. A escola atual do aluno deve coincidir com
a escola da turma. Suspender aprovação, remover atribuição, fechar turma ou
transferir o aluno revoga acesso nas próximas consultas.

Listas e detalhes usam a mesma política. O roster de uma turma antiga não pode
servir para recuperar os dados atuais de um aluno transferido. O banco preserva
a matrícula histórica, mas o gestor antigo e professor sem atribuição atual
não recebem esse aluno na resposta. O aluno e o novo gestor autorizado conseguem
consultar seu histórico completo; `org_admin` preserva a visão organizacional.

## APIs

Listas `GET /schools`, `/people`, `/classes`, `/group-types` e `/groups` retornam
`{items,total,page,pageSize}`. Aceitam `page` (padrão 1), `pageSize` (1–100, padrão 20),
`search`, `status` e filtros `schoolId`/`role` quando pertinentes à entidade.
Pesquisa é parametrizada, incluindo escape de curingas. Todos os caminhos abaixo
partem de `/api/education`.

| Operação | Contrato |
| --- | --- |
| `GET /overview` | Arrays schools/people/classes/groupTypes/groups de até 100 itens por categoria, capabilities e scope.schoolIds |
| `POST /schools` | `{name,city?,state?}` → 201 `{school}` |
| `GET /schools/:id` | Gestão autorizada recebe `{school,staff}` |
| `PATCH /schools/:id` | `{name?,city?,state?,status?:active\|archived}` → `{school}` |
| `POST /schools/:id/staff` | Org admin associa pessoa existente: `{userId,role:school\|teacher}` → 201 `{staff}` |
| `DELETE /schools/:id/staff/:userId` | Encerra staff e atribuições docentes daquela escola, 204; escola não remove gestores |
| `POST /people` | `{name,email,roles,schoolId?}` → 201 `{person}` convidada |
| `GET /people/:id` | `{person,schoolHistory,enrollments,groups}` após autorização |
| `PATCH /people/:id` | `{name?,status?,roles?,profile?}` → `{person}` |
| `POST /people/:id/archive` | Arquiva preservando identidade e histórico → `{person}` |
| `PATCH /teachers/:id` | Org admin: `{approvalStatus,certifications?}` → `{teacher}` |
| `POST /classes` | `{schoolId,name,startsOn?,endsOn?}` → 201 `{class}` |
| `GET /classes/:id` | `{class,enrollments,teachers}` com alunos filtrados pelo escopo atual |
| `PATCH /classes/:id` | `{name?,startsOn?,endsOn?,status?:active\|closed\|archived}` → `{class}` |
| `POST /classes/:id/enrollments` | `{studentId}` → 201 `{enrollment}` |
| `DELETE /classes/:id/enrollments/:studentId` | Encerra matrícula como cancelled, 204 |
| `POST /classes/:id/teachers` | `{teacherId}` → 201 `{assignment}` |
| `DELETE /classes/:id/teachers/:teacherId` | Encerra atribuição, 204 |
| `POST /students/:id/transfer` | Org admin: `{schoolId,reason?}` → `{person,transferred}` |
| `POST /group-types` | Org admin: `{name,position?}` → 201 `{groupType}` |
| `PATCH /group-types/:id` | Org admin: `{name?,position?,status?}` → `{groupType}` |
| `POST /groups` | `{name,typeId,parentId?,schoolId?}` → 201 `{group}` |
| `GET /groups/:id` | Gestão autorizada recebe `{group,members}` |
| `PATCH /groups/:id` | `{name?,typeId?,parentId?,status?}` → `{group}`; escola do grupo é imutável |
| `POST /groups/:id/members` | `{userId}` → 201 `{membership}` |
| `DELETE /groups/:id/members/:userId` | Encerra participação, 204 |

IDs são UUIDs. Datas de turma aceitam `null` para limpar o valor e não podem terminar
antes do início. `parentId:null` remove o pai. Patches vazios ou campos extras são
recusados. Erros de payload retornam 400; falta de permissão, 403; recurso de outra
org/inexistente, 404; estado incompatível/duplicação de cadastro, 409.

Criações repetidas dos vínculos ativos de staff, matrícula, professor e grupo
retornam 201 com o mesmo registro ativo. Não criam histórico duplicado. Um vínculo
encerrado pode ser criado novamente como nova linha, preservando a anterior.

`Person` inclui `id,name,email,roles,status,profile,archivedAt,schoolId,schoolIds` e
`teacherProfile:{approvalStatus,certifications}|null`. `schoolId` é a afiliação atual
do aluno; `schoolIds` contém vínculos de staff. Certificações têm
`{name,issuer,issuedOn?,expiresOn?}` e são editadas somente pelo administrador.
O professor pendente recebe seu próprio perfil no overview, sem alunos atribuídos.

## Pessoas, encerramento e transferência

O gestor cadastra novos alunos/professores apenas em escola sob sua gestão; os papéis
permitidos nesse cadastro são student/teacher. Somente org admin cadastra gestores
ou novos administradores e associa profissionais existentes. Não existe concessão
do papel operator neste módulo. Convites usam o fluxo de link local da F02.

O gestor pode alterar nome/perfil de seus profissionais, mas não seus papéis ou
status global, nem arquivar um professor compartilhado com outra escola. Pode
suspender/arquivar alunos cujo único papel seja student e que pertençam à sua escola.
O administrador controla papéis, preservando ao menos um org admin ativo.

Arquivar pessoa suspende login, revoga sessões e encerra matrículas, staff,
atribuições docentes e participações em grupos. A afiliação escolar do aluno é
mantida para a gestão consultar/restaurar o cadastro. Restaurar status active não
reabre vínculos anteriores nem aprova automaticamente um professor.

Fechar turma marca suas matrículas ativas como completed e encerra atribuições
docentes; outras turmas do aluno continuam ativas. Turma arquivada marca vínculos
como cancelled. Reabrir a turma não ressuscita vínculos anteriores.

Transferência é exclusiva do org admin e ocorre dentro da mesma org. Encerra a
afiliação escolar anterior, marca matrículas ativas como transferred e encerra
participações em grupos escolares. Grupos globais da organização são preservados.
A nova escola é vinculada sem trocar o ID do usuário, seus históricos ou qualquer
carteira futura. A escola nova não recebe matrículas/grupos inventados: gestores
escolhem as turmas e grupos de destino. Repetir o mesmo destino retorna
`transferred:false`, sem duplicar a transferência.

Arquivar escola encerra staff, atribuições e matrículas, arquiva turmas/grupos
locais e encerra suas participações. Identidades e afiliação histórica dos alunos
permanecem para transferência administrativa posterior. Restaurar a escola não
reativa automaticamente os vínculos encerrados.

## Hierarquia e concorrência

Grupos podem ter pai da mesma organização. Um filho de grupo escolar precisa
manter a mesma escola; um grupo organizacional pode agrupar escolas diferentes.
Mudar pai não pode produzir ciclo. Arquivar um grupo arquiva descendentes e encerra
participações; restaurar o pai não restaura descendentes automaticamente. Um tipo
com grupos ativos não pode ser arquivado.

Todas as mutações escolares usam uma transação e advisory lock por organização.
Isso serializa mudanças de hierarquia, transferência, matrículas e vínculos no
piloto, evitando duas reparentagens concorrentes formarem um ciclo e evitando
transferência concorrer com matrícula na escola anterior. Índices e FKs completam
as garantias no banco.

Depois de esperar o lock, a rotina revalida a sessão, o host, org, status e papéis
usando **o mesmo client transacional**, sem abrir outra conexão. Expiração usa
o relógio atual do banco. Um pedido enfileirado perde autorização se sua sessão
ou papel for revogado durante a espera. Isso também evita esgotar o pool com
transações aguardando uma conexão adicional para autorização.

Mutações registram auditoria com ator e entidade; nomes, e-mails, conteúdos de
perfil e tokens não são copiados para o evento. Não há exclusão física nas APIs.

## Evidência e escopo

`tests/education.test.ts` usa schema PostgreSQL e filesystem próprios para testar
isolamento, perfis, aprovação, multimatrícula, encerramento, transferência, grupos
e concorrência. Comandos:

```sh
npx vitest run tests/education.test.ts
npx eslint server/education.ts server/permissions.ts server/app.ts
npx tsc --noEmit
```

A evidência da revisão independente é consolidada em `PHASE04_REVIEW.md`.
Currículos permanecem na fase 06; professores não ganham permissão implícita para
editar o programa. Carteira, relatórios e mentorias usarão as identidades e o guard
de aluno preservados nesta fase.
