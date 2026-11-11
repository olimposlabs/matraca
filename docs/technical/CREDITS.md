# Créditos: carteira e administração local — F05

Estado: implementado no piloto local em `server/wallet.ts`, `server/credits.ts` e na migração `005_wallet.sql`. Esta fase fornece a carteira real, suas regras e a administração. A avaliação de mídia, as recompensas de conclusão, a compra de créditos e o faturamento integrarão este núcleo nas fases correspondentes. Não há chamada de pagamento ou IA nesta API.

## Unidade, saldo e lançamentos

Um crédito representa um minuto de avaliação, sempre arredondado para cima. `creditsForDuration` recebe somente duração positiva inteira em microssegundos, já verificada pelo servidor: 30 segundos = 1, 119 segundos = 2, 301 segundos = 6. Metadados de duração enviados pelo cliente não são autoridade para cobrança.

Cada `(org_id,user_id)` possui carteira independente. O saldo total inclui créditos reservados; `available = balance - reserved`. A leitura de uma carteira ainda inexistente retorna zeros sem gravar no banco. O login de um aluno concede uma única vez um crédito inicial, na mesma transação que consome o link e cria a sessão. Repetir o login não repete o benefício.

`wallet_entries` é um registro de lançamentos que somente permite inserção: um trigger rejeita alteração e exclusão. Concessões e ajustes positivos criam lotes; consumos e ajustes negativos registram a utilização dos lotes por ordem de criação. Um estorno de consumo devolve a quantidade aos mesmos lotes, preservando as origens. A transferência de escola mantém a identidade e a carteira do aluno.

Origens aceitas: `initial`, `lesson`, `module`, `course`, `purchase`, `manual`, `leaderboard`, `evaluation`, `refund`, `adjustment`. As origens de aulas, cursos, compras e rankings são pontos de integração, não endpoints públicos para o cliente conceder benefícios. O nome apresentado da unidade vem de `org.branding.creditSingular` e `creditPlural`; não altera os números ou a unidade contábil.

O núcleo exporta funções de concessão, ajuste, reserva, consumo, liberação, estorno e consulta. As variantes `grantCreditsInTransaction`, `adjustCreditsInTransaction`, `grantInitialCreditInTransaction`, `consumeReservationInTransaction` e `refundConsumptionInTransaction` permitem incluir a movimentação na transação do evento que a provoca. Elas não autenticam chamadas: os módulos chamadores precisam validar identidade, escopo e evento confiável.

Uma reserva torna créditos indisponíveis sem reduzir o saldo. Consumir a reserva cria o lançamento de débito e reduz saldo e reserva na mesma transação; liberar uma reserva pendente apenas devolve disponibilidade. Consumo e liberação repetidos são idempotentes, mas não podem inverter o estado final um do outro. Um consumo já confirmado exige estorno, registrado uma única vez por lançamento original. A integração com o processamento de mídia deve salvar resultado e consumir reserva na mesma transação.

## Permissões e concorrência

| Perfil | Leitura | Alterações |
| --- | --- | --- |
| Aluno | Sua própria carteira | Nenhuma operação administrativa |
| Professor | Não acessa esta administração | Nenhuma |
| Gestor escolar (`school`) | Alunos atualmente vinculados a escolas ativas que administra; política, pacotes ativos e limites dessas escolas | Concessão, se autorizada pela organização e dentro do teto mensal da escola |
| Administrador da organização | Alunos e carteiras da própria organização, inclusive registros históricos | Concessão, ajuste, estorno, pacotes e políticas |
| Operador do backoffice | Organização alvo indicada na rota central | Mesmas operações administrativas, autenticado exclusivamente no backoffice |

Permissões cumulativas não ampliam a delegação financeira escolar por meio do acesso pedagógico: ser também aluno ou professor não permite gerir uma carteira fora da escola administrada. Ajustes e estornos de carteiras históricas continuam disponíveis ao administrador e ao operador; novas concessões exigem organização e aluno disponíveis.

Cada mutação trava a organização alvo com `pg_advisory_xact_lock(hashtextextended(orgId,4))`, a mesma chave utilizada pela gestão educacional. Após obter o lock, revalida a sessão persistida, host, expiração, revogação, status da organização e do usuário, papéis e vínculos atuais. As consultas de autorização usam a mesma conexão transacional. Assim, uma requisição aguardando na fila não conserva um papel, escola ou política já revogados. As linhas de usuário e organização autenticados e da organização alvo permanecem protegidas por locks de leitura até o término da mutação.

O núcleo trava o titular e depois a carteira, mantendo a ordem compatível com a concessão inicial no login. Reserva, saldo, lotes, lançamento, recibo administrativo e auditoria são transacionais. Não se permite saldo disponível negativo ou gasto concorrente acima do saldo. Quantidades por movimentação são inteiras, até 1.000.000; saldo máximo é 1.000.000.000.

## Delegação escolar e pacotes

`org_credit_policies` guarda `schoolExtrasEnabled` e `defaultSchoolMonthlyLimit`. Os valores padrão são `false` e `0`; consultar a política não cria registro. `school_credit_limits` pode substituir o teto de uma escola por outro inteiro entre zero e 1.000.000.000.

O teto limita créditos concedidos por gestores daquela escola no mês civil de `America/Sao_Paulo`. Cada recibo conserva a escola de origem e o mês da concessão. Transferir o aluno não move o gasto entre escolas. Concessões do administrador ou operador não utilizam essa delegação escolar. Ajuste e estorno não recompõem o teto de concessões; conceder um benefício e posteriormente consumir ou estornar uma avaliação são eventos distintos. Reduzir um teto abaixo do já utilizado não retira créditos; bloqueia novas concessões até existir disponibilidade.

Pacotes administrativos são modelos de concessão com nome, quantidade, descrição e status. Não são ofertas de compra nem tabelas de preço. Arquivar um pacote impede uma nova concessão com esse pacote. Editar sua quantidade não altera concessões anteriores.

O cliente fornece um `eventId` UUID por intenção, reutilizado em tentativas da mesma operação. Não pode escolher a chave interna do livro de lançamentos. `credit_admin_events` registra o pedido original, responsável, lançamento e eventual escola/mês. Repetir o mesmo pedido retorna o lançamento original sem novo crédito ou consumo do teto. Mudar responsável, aluno, motivo, quantidade, pacote ou tipo de operação reutilizando o UUID retorna `409`.

O replay revalida autorização, escopo, disponibilidade do alvo e, para concessões escolares, a política atual de autonomia. Depois disso, devolve o resultado original mesmo que o pacote tenha sido editado ou arquivado, ou o teto restante tenha caído. Não recalcula a quantidade de um pacote já concedido.

Conceder créditos não cria cobrança nesta fase. O faturamento de consumo, separado do saldo e dos benefícios concedidos, será integrado na fase de faturamento.

## Contrato HTTP

Todas as mutações exigem sessão e `x-matraca-request: 1`; a proteção de origem da aplicação também se aplica. JSON é estrito: campos inesperados, quantidades inválidas e UUIDs malformados retornam `400`. O alvo da organização vem do host nas rotas do parceiro, nunca de um campo livre do corpo.

Os caminhos abaixo usam `P = /api/credits` para o administrador/gestor da organização, ou `P = /api/backoffice/credits/orgs/:orgId` para o operador central. Organizações do tipo backoffice não possuem carteiras de alunos.

| Método e caminho | Entrada | Resposta |
| --- | --- | --- |
| `GET /api/wallet` | Filtros de extrato | Extrato do aluno autenticado |
| `GET P/students` | `page=1`, `pageSize=20` (máx. 100), `search`, `schoolId` | `{items,total,page,pageSize,org}` |
| `GET P/students/:id` | Filtros de extrato | Extrato administrativo autorizado |
| `POST P/students/:id/grant` | `{eventId,reason,amount}` ou `{eventId,reason,packageId}` | `{entry,wallet}` |
| `POST P/students/:id/adjust` | `{eventId,reason,delta}`; delta não zero | `{entry,wallet}` |
| `POST P/students/:id/refund` | `{eventId,reason,entryId}`; consumo original | `{entry,wallet}` |
| `GET P/schools` | — | `{items:[{id,name,status}]}`, incluindo escolas vazias autorizadas |
| `GET/PATCH P/policy` | PATCH parcial de `schoolExtrasEnabled`, `defaultSchoolMonthlyLimit` | `{policy}` |
| `GET/PATCH P/schools/:schoolId/limit` | PATCH `{monthlyLimit}` | `{limit:{schoolId,monthlyLimit,used,remaining,month,schoolExtrasEnabled}}` |
| `GET P/packages` | — | `{items:[{id,name,amount,description,status}]}` |
| `POST P/packages` | `{name,amount,description?}` | `201 {package}` |
| `PATCH P/packages/:id` | Parcial `{name,amount,description,status}` | `{package}` |

As demais operações bem-sucedidas retornam `200`. Falta de sessão ou sessão revogada retorna `401`; papel, escola ou política sem autorização, `403`; entidade inexistente no tenant, `404`; conflito de evento, pacote arquivado, alvo indisponível ou teto mensal, `409`; saldo disponível insuficiente no núcleo, `402`.

O aluno da listagem inclui `id,name,email,status,roles,archivedAt,schoolId,schoolName,balance,reserved,available`. `org` contém `id,name,branding`, para a interface central usar os rótulos da organização alvo.

O extrato retorna `{org,student,wallet,entries,reservations,origins,page,limit,total}`. `wallet` contém `balance,reserved,available`. Os campos de lançamentos, reservas e origens seguem os nomes `snake_case` do núcleo; cada lançamento acrescenta `actorName`. O fingerprint interno não é exposto. O responsável central aparece como “Equipe Matraca”; eventos automáticos, como “Sistema”. A resposta não expõe o nome pessoal de um operador de outra organização.

Filtros do extrato: `page=1`, `limit=25` (máx. 100), `source`, `from`, `to`, `actorSearch`. As datas usam `YYYY-MM-DD`, inclusivas no fuso `America/Sao_Paulo`. Nome do responsável e busca de alunos tratam `%` e `_` como caracteres literais. Os filtros afetam lançamentos e `total`; saldo, origens disponíveis e até 100 reservas recentes permanecem completos no escopo da carteira. A consulta usa uma transação de leitura `REPEATABLE READ` para manter um retrato consistente.

## Validação

`tests/wallet.test.ts` verifica arredondamento, imutabilidade, origens, reserva concorrente, idempotência, consumo, liberação, estorno e limites do núcleo. `tests/credits.test.ts` cobre rotas reais com PostgreSQL em schema exclusivo: isolamento, papéis, concessão, pacotes, replay, limites por escola, concorrência e revogação durante espera. As rotinas de teste removem apenas seus schemas e diretórios temporários. A evidência de revisão da fase é registrada em `PHASE05_REVIEW.md`.
