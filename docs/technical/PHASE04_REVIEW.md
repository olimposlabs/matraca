# F04 — revisão de gestão escolar e autorização

Revisão interna independente realizada no worktree da fase 04. Foram examinados `server/education.ts`, `server/permissions.ts`, `server/migrations/004_education.sql` e a integração da API. As evidências estão em [education.test.ts](../../tests/education.test.ts).

## Isolamento da validação

Cada execução cria schema PostgreSQL com nome aleatório, aplica as migrações nesse schema e usa diretório temporário exclusivo para armazenamento. A limpeza remove somente esses recursos. A suíte não trunca tabelas nem modifica o seed da demonstração.

Uma rota adicionada somente à instância de teste chama `requireStudentScope` diretamente. Ela verifica o contrato de autorização que será reutilizado nas fases de mídia e mentoria; não existe na aplicação publicada.

## Evidências locais

Node `24.22.2`, Vitest `4.1.12`, PostgreSQL 17: **20 testes passaram, sem skips**. Lint da suíte, `tsc --noEmit` e `git diff --check` também passaram.

| Área | Resultado observado |
| --- | --- |
| Escolas | Criação, busca, paginação, edição e arquivamento preservam o registro |
| Gestão escolar | Gestor vê sua escola, cadastra alunos/professores locais e gerencia turma e matrícula próprias |
| Elevação de acesso | Gestor não cria escola, não atribui `org_admin` nem papéis mistos privilegiados, não promove gestor e não aprova ou suspende globalmente professor |
| Professores | Aprovação e atribuição à turma são necessárias; aluno sem vínculo com a turma permanece inacessível |
| Certificações | Dados de certificação são registrados e retornados no perfil do professor |
| Matrículas | Um aluno participa de duas turmas; fechar uma preserva matrícula `completed` e mantém a outra ativa; turma fechada rejeita nova matrícula |
| Concorrência de matrícula | Pedidos simultâneos preservam exatamente uma matrícula ativa |
| Revogações | Suspensão da aprovação, fim da atribuição à turma, remoção da escola e suspensão do usuário retiram acesso do professor |
| Transferência | ID do aluno e históricos permanecem; escola atual muda; matrícula anterior deixa de estar ativa |
| Acesso após transferência | Antigo gestor/professor perde o guard, a consulta individual, a listagem do aluno e sua entrada no roster antigo; novo gestor e o próprio aluno mantêm acesso |
| Grupos após transferência | Vínculo com grupo escolar antigo é encerrado, enquanto grupo da organização permanece |
| Organizações | IDs estrangeiros não permitem ler, editar escola, matricular, atribuir professor ou transferir aluno |
| Banco | Chaves estrangeiras compostas rejeitam vínculos entre organizações e matrícula com escola incompatível com a turma |
| Hierarquia | Pai/tipo de outra organização e ciclos são rejeitados; mudanças concorrentes A→B/B→A não criam ciclo |
| Arquivamento | Pessoa e histórico são preservados, com revogação da sessão |
| Continuidade administrativa | Último administrador ativo não pode remover seu papel, suspender ou arquivar o próprio acesso |
| Requisições enfileiradas | Suspensão, remoção de papel e logout ocorridos durante espera pelo lock impedem a mutação posterior |

## Achado tratado na revisão

A versão inicial de `mutate` obtinha a identidade antes de aguardar o lock da organização. Uma requisição enfileirada poderia manter a fotografia antiga de papéis ou sessão depois de uma revogação.

A implementação passou a reler sessão, host, organização, status, arquivamento e papéis no mesmo cliente transacional, depois do lock, usando o relógio atual para validade da sessão. Não abre outra conexão enquanto mantém a transação bloqueada.

A regressão controla o lock no PostgreSQL, observa a requisição aguardando em `pg_locks`, efetua suspensão, mudança de papel ou logout e libera a fila. Os três casos retornam `401` ou `403`, conforme a causa, sem criar a escola solicitada. A falha foi identificada por revisão do código; esses testes foram executados após a correção.

## Leitura de autorização e integridade

As mutações educacionais são serializadas por organização dentro de transações. Transferências, alterações de hierarquia e matrículas usam essa mesma fronteira. Índices parciais impedem múltiplos vínculos atuais incompatíveis; registros encerrados permanecem disponíveis ao escopo autorizado.

`STUDENT_SCOPE_SQL` e `PERSON_SCOPE_SQL` usam IDs, papéis e organização obtidos da sessão no servidor. A autorização do professor verifica aprovação, escola ativa, vínculo de staff, atribuição à turma e matrícula atual. As consultas de roster e de pessoas aplicam o escopo atual, sem conceder acesso apenas pela existência de histórico anterior.

Não foram identificados achados bloqueantes pendentes no escopo examinado após a correção da revalidação transacional.

## Limites e gates

Esta revisão cobre APIs, autorização, persistência e concorrência. A validação visual e as jornadas completas no navegador pertencem à inspeção de frontend. Certificações são registros administrativos; nenhuma verificação externa foi exercitada.

A transferência preservou o ID do usuário, mas saldo financeiro não foi testado nesta fase: a carteira será validada na F05. Não foi realizado teste de carga das mutações serializadas por organização.

CI remota, revisão GitHub Codex Review ou mecanismo substituto aprovado, SHA final e merge permanecem **Não confirmados** neste relatório. Testes locais aprovados não encerram esses gates.
