# F05 — revisão independente de carteira e concessões

Revisão interna independente realizada no worktree da fase 05, em 11/11/2026. Foram examinados `server/wallet.ts`, `server/credits.ts`, `server/migrations/005_wallet.sql`, a integração do crédito inicial em `server/auth.ts` e os contratos em [CREDITS.md](CREDITS.md). As evidências executáveis estão em [wallet.test.ts](../../tests/wallet.test.ts) e [credits.test.ts](../../tests/credits.test.ts).

O fundador autorizou a revisão independente como mecanismo substituto de revisão, mantendo a exigência de CI verde antes do merge. Este documento registra a revisão local do código; não afirma que CI remota, commit final ou merge já ocorreram.

## Isolamento e evidências

Cada suíte cria seu próprio schema PostgreSQL aleatório e aplica as migrações nesse schema. A suíte HTTP também cria armazenamento e caixa de e-mail temporários exclusivos. A limpeza remove somente esses recursos. Não foi alterado o banco da demonstração nem reescrita a migração 005 aplicada nesse banco.

Node `24.22.2`, Vitest `4.1.12`, PostgreSQL 17: **40 testes passaram, sem skips** — 19 do núcleo e 21 da API. `tsc --noEmit`, lint das duas suítes e `git diff --check` passaram. O teste de filtros usa lançamentos sintéticos inseridos com datas explícitas; não desativa o trigger de imutabilidade nem altera lançamentos existentes.

| Área | Evidência observada |
| --- | --- |
| Arredondamento | 30, 60, 61, 119, 300 e 301 segundos; primeiro microssegundo após o limite; entradas inválidas rejeitadas |
| Crédito inicial | Oito chamadas concorrentes geram um lançamento; dois logins reais não repetem a concessão |
| Concorrência com login | Primeira concessão manual aguarda a linha de usuário travada pelo login e termina após o crédito inicial, sem deadlock e com saldo final correto |
| Saldo reservado | Duas reservas pelo último crédito produzem apenas uma reserva; ajuste negativo não pode consumir saldo reservado |
| Idempotência | Repetir concessão, reserva, consumo, liberação ou estorno não duplica o efeito; mudar titular ou conteúdo da mesma chave é rejeitado |
| Origens | Consumo utiliza lotes FIFO; estorno repõe exatamente os lotes utilizados; consumo e ajuste negativo mantêm alocações |
| Atomicidade | Falha simulada ao persistir o resultado na mesma transação reverte consumo, saldo e alocações |
| Estado final da reserva | Reserva liberada não volta a ser consumível; repetir a solicitação conserva o estado liberado |
| Imutabilidade | UPDATE e DELETE de lançamentos são rejeitados; correções usam novos lançamentos |
| Integridade no banco | Chaves compostas rejeitam alocações, estornos e reservas ligados a outra carteira |
| Espaço de chaves | Chave externa semelhante à de avaliação não colide com o consumo interno |
| Isolamento | Administrador comum não escolhe outra organização ou usa as rotas centrais; operador autenticado no backoffice atua no alvo explícito |
| Papéis | Aluno lê sua carteira; professor sem papel de aluno não acessa a carteira; nenhum deles usa administração de créditos |
| Delegação escolar | Gestor lê apenas alunos da escola ativa administrada; autonomia desligada impede concessão, mas mantém essa leitura |
| Papéis cumulativos | Ser também aluno ou professor não libera consulta administrativa, listagem ou concessão fora da escola gerida; acesso pedagógico autorizado continua funcionando |
| Teto mensal | Duas concessões concorrentes disputando o último crédito do teto produzem somente uma; replay não consome teto de novo; concessão de administrador não utiliza o teto escolar |
| Transferência | Identidade e saldo permanecem; antigo gestor perde acesso e novo gestor recebe escopo; orçamento histórico continua na escola que concedeu |
| Revalidação após fila | Logout, perda de papel, transferência do alvo ou revogação da autonomia durante espera pelo lock impedem a concessão e deixam orçamento e saldo intactos |
| Replay e revogação | Replay exige autonomia atual; reativá-la retorna o lançamento original, mesmo com teto já utilizado |
| Pacotes | Alterar quantidade ou arquivar pacote não muda concessão anterior; novo evento respeita valor/status atual; pacote estrangeiro é rejeitado |
| Ajuste e estorno | Gestor escolar não ajusta nem estorna; administrador estorna consumo uma única vez mesmo com IDs de pedido distintos |
| Extrato | Origem, responsável e intervalo de dias são filtrados antes da contagem e paginação; limites de meia-noite de São Paulo são inclusivos corretamente |
| Responsável central | Nome pessoal de operador de outro tenant é substituído por “Equipe Matraca”, também na busca; fingerprint não integra a resposta |

## Achados tratados

1. **Referências financeiras e chaves externas.** A revisão inicial pediu referências compostas de organização/titular para movimentos relacionados e separação entre chaves de concessão, ajuste e consumo. As referências compostas e os namespaces estão presentes; regressões negativas verificam os limites no banco e no serviço.
2. **Ordem dos locks no primeiro crédito.** O login já trava o usuário antes de criar a carteira. A criação da carteira por outra operação poderia formar uma espera circular com esse login. `lockWallet` passou a obter `FOR KEY SHARE` do titular antes do INSERT e do lock da carteira. A regressão mantém o usuário travado, observa a concessão manual aguardando em `pg_blocking_pids`, concede o crédito inicial e libera a operação. Ambas terminam com saldo 3. O problema foi identificado por leitura; a regressão foi executada após a correção.
3. **Permissões atuais antes do replay.** A consulta de um recibo idempotente não pode ignorar autonomia revogada ou indisponibilidade do alvo. A API valida sessão, escopo, disponibilidade e autonomia antes de retornar o recibo; só a resolução do pacote e o gasto de novo teto ficam depois do replay.
4. **Separação entre acesso pedagógico e financeiro.** O predicate pedagógico permite acesso ao próprio aluno e ao aluno de uma turma lecionada. A delegação financeira passou a exigir vínculo atual de gestor na escola ativa do aluno. As regressões cobrem tanto `school + student` quanto `school + teacher`, incluindo a listagem e a consulta individual.

Não foram identificados achados bloqueantes pendentes no escopo revisado após essas correções.

## Fronteira transacional examinada

As mutações administrativas usam o mesmo lock por organização da gestão educacional. Depois de aguardar, revalidam sessão, host, expiração, organização, usuário e papéis na conexão transacional; os vínculos atuais do aluno e a política são relidos nessa fronteira. A organização alvo das operações centrais também é protegida por lock de leitura.

O núcleo serializa os movimentos por titular/carteira. Lançamento, lotes, alocações, reserva, saldo, recibo administrativo e auditoria são persistidos na transação correspondente. O consumo exportado para transação externa permite que a futura avaliação confirme resultado e cobrança juntos. A API pública não aceita origem financeira arbitrária enviada pelo navegador.

O extrato usa `REPEATABLE READ READ ONLY`; a autorização, contagem, lançamentos, saldo e origens são lidos na mesma fotografia. O orçamento guarda escola e mês de origem no recibo, sem recalcular o passado pela escola atual do aluno.

## Limites e gates

Esta revisão cobre núcleo, APIs, persistência, autorização, contratos e concorrência controlada. Não é teste de carga; mutações administrativas da mesma organização são serializadas. A inspeção visual e as jornadas no navegador são evidências separadas da revisão de backend.

As funções internas de carteira não autenticam o chamador. As fases de cursos, avaliações, rankings, compras e faturamento precisarão aplicar autorização e identificar eventos confiáveis antes de chamá-las. A integração de mídia deverá verificar o estado retornado da reserva e persistir resultado e consumo na mesma transação. A regressão atual verifica esse contrato transacional, não um processamento de mídia já integrado.

Não foram exercitados cobrança monetária, gateway de pagamento, IA real, webhook financeiro ou preço de crédito nesta fase. Concessão não implica faturamento; essas integrações pertencem às fases correspondentes.

O resultado desta revisão independente é favorável ao escopo examinado. O SHA final e a CI remota precisam ser confirmados pelo responsável pela integração antes do merge. Nenhum push, merge ou deploy foi realizado por esta revisão.
