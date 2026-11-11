# Comércio e faturamento simulado — F12

## Fronteiras

`server/commerce.ts` atende compras avulsas da organização nativa Matraca. `server/billing.ts` atende contratos e faturas de organizações parceiras. `server/commerce-access.ts` concentra a autorização e a transação das mutações. A migração `012_commerce.sql` adiciona os registros financeiros e o histórico observado de elegibilidade. O núcleo matemático está em [PRICING_CORE.md](PRICING_CORE.md).

Não há gateway, cartão, boleto, cobrança externa, juros ou emissão fiscal. Pedidos, eventos e demonstrativos identificam a simulação. Créditos de prática, pontos e moeda permanecem separados. A concessão de créditos white label não é uma cobrança adicional: o faturamento contabiliza consumo concluído, evitando cobrar novamente concessões ou reservas.

## Catálogo e pedidos avulsos

Ofertas possuem revisão, estado `draft|published|archived` e tipo `credits|course`. Editar coloca novamente em rascunho; publicar/arquivar exige `expectedRevision`. Pacotes exigem `creditAmount` explícito e tabela de preços. Cursos exigem versão publicada e preço total em centavos. Seus créditos são derivados da versão: `creditMode=acquisition` concede `acquisitionCredits`; `progress` concede zero na compra. Um `creditAmount` divergente enviado pelo cliente é rejeitado. A compra não antecipa recompensas de progresso.

O pedido congela título, preço, quantidade de créditos, curso/versão, revisão da oferta, moeda e sinalização simulada. Eventos posteriores usam esse snapshot, inclusive se a oferta ou curso foi arquivado. A conta precisa continuar ativa com papel de aluno e a organização ativa; o módulo de cursos também precisa continuar habilitado. Uma nova compra não aceita oferta/curso arquivado. Não há compra repetida de curso com matrícula já existente, inclusive cancelada; esse caso requer resolução administrativa explícita.

`clientKey` torna a criação idempotente. A mesma chave com outra oferta retorna 409. Eventos de pagamento têm `eventId`, fingerprint da intenção e estados `pending|approved|declined|cancelled`. Só pedido pendente muda: aprovado concede matrícula e créditos, recusado/cancelado encerra sem conceder. Evento tardio de pedido terminal é registrado como ignorado. Repetição não duplica concessão. Aprovação, matrícula, lançamento de carteira e entitlement acontecem na mesma transação. Se uma atribuição escolar concorrente já matriculou o aluno, a aprovação retorna 409 e nada é debitado ou concedido; o pedido pendente pode ser cancelado.

Todas as mutações usam o lock educacional da organização (`hashtextextended(orgId,4)`) e revalidam sessão, papéis e organização dentro da transação depois da espera. O aluno acessa só os próprios pedidos no próprio host. O operador central precisa ser operador do backoffice e indicar a organização nativa. As chaves estrangeiras compostas impedem misturar organizações nos vínculos de curso, carteira e pedido. Nome do destinatário aparece no pedido; e-mail não é incluído.

## Histórico e corte mensal

A observação começa quando a migração registra o baseline completo, ou quando uma organização é criada. Escolas e usuários geram eventos de elegibilidade por trigger quando seu estado relevante muda. O aceite é registrado no primeiro `session_started` observado; o baseline só reutiliza evidência anterior de aceite existente na auditoria. O status histórico não é reconstruído pelo estado atual.

O fechamento de competência `M` usa o instante inicial de `M+1` em `America/Sao_Paulo`, com intervalo `[início, corte)`. Conta escolas ativas e alunos ativos, não arquivados, com papel de aluno e aceite registrado antes do corte. Cada usuário conta uma vez independentemente das turmas/papéis cumulativos. Professores sem papel de aluno e convites não aceitos ficam fora. Se o histórico conhecido começa depois do corte, retorna 409 com explicação; não inventa uma contagem.

A tabela de consumo é selecionada pela vigência de `M`. Licenças são selecionadas pela vigência de `M+1`. Contratos têm versões append-only, revisão por vigência mensal e CAS. Uma publicação que afetaria período já fechado é bloqueada. A prévia usa a última revisão de cada vigência. A fatura guarda cópias dos dois contratos, elegibilidade, linhas, consumo, ajustes e totais. O snapshot fechado é imutável.

O fechamento usa lock por organização, chave única `(org_id,consumption_month)` e retorna a fatura original em replay. Antes de fechar um corte passado real, recusa enquanto houver outra transação do mesmo banco iniciada antes do corte ainda aberta: ela poderia confirmar um lançamento anterior ao corte depois da apuração. As gravações normais do ledger não permitem retrodatação pela API.

A injeção `now(orgId)` altera apenas o relógio da apuração financeira. Não muda relógio de autenticação, histórico de elegibilidade, ledger ou criação de ajustes. Avançar o relógio não produz eventos futuros; o demonstrativo informa quando o relógio ultrapassa o real. Voltar o relógio não retrodata uma concessão ou ajuste criado agora. O agendamento F13 deve chamar a mesma função de fechamento, sem implementação paralela.

## Consumo, estornos e ajustes

Somam-se apenas lançamentos `consumption/evaluation`. Consumo com estorno registrado antes do corte é retirado do líquido da própria competência; concessões, compras de crédito e reservas não entram. A tabela de volume aplica a faixa alcançada ao líquido inteiro; a progressiva calcula cada parcela. Não há ponto flutuante em cálculos monetários: valores são centavos inteiros, intermediários `BigInt` e limites seguros.

Cada consumo recebe uma alocação monetária imutável na fatura. No progressivo, a distribuição segue a ordem estável de criação/ID; no volume, todos recebem o preço da faixa alcançada. Um estorno posterior ao fechamento gera ajuste negativo pelo valor originalmente alocado àquela avaliação, sem reprecificar a fatura original. É aplicado uma única vez em uma competência posterior elegível. Assim, mudar contrato ou faixa futura não muda o valor histórico do estorno.

Ajustes manuais exigem motivo e chave idempotente e permanecem vinculados à fatura original. Não alteram a carteira. Ficam pendentes até uma apuração posterior ao período original e à data real do ajuste. Ajustes podem resultar em total negativo, exibido como saldo financeiro a favor; não são silenciosamente truncados para zero.

Liquidação é simulada, única por fatura, registrada por operador e evento idempotente. Reutilizar evento em outra fatura retorna 409. Faturas liquidadas continuam com snapshot original; ajustes seguem para demonstrativo posterior.

## Contratos HTTP

Todas as mutações usam `x-matraca-request: 1`, sessão do host e controles de origem existentes. Erros: payload 400, acesso 401/403, recurso de outra organização 404, conflito de revisão/estado 409. Listas paginadas usam `{items,total,page,pageSize}`.

Comércio central: `/api/backoffice/commerce/orgs/:orgId`. Comércio do aluno: `/api/commerce`.

| Método e sufixo | Uso |
| --- | --- |
| GET `/courses` (central) | `{items:[{id,title,versionId,version,creditMode,acquisitionCredits}]}`, versões de cursos publicados |
| GET `/catalog?page&pageSize` | Central vê todos os estados; aluno vê ofertas publicadas e cursos habilitados |
| POST `/catalog/preview` (central) | Mesmo input de oferta, retorna `{quote:{data,courseId,courseVersionId,amountCents,pricing},simulated:true}` |
| POST `/catalog` (central) | `{title,kind,creditAmount?,priceTable?,courseVersionId?,coursePriceCents?}` → 201 `{offer}` |
| PUT `/catalog/:id` (central) | Oferta completa + `expectedRevision` → `{offer}` |
| POST `/catalog/:id/publish` ou `/archive` (central) | `{expectedRevision}` → `{offer}` |
| POST `/orders` (aluno) | `{offerId,clientKey}` → 201 `{order}` |
| GET `/orders?page&pageSize` | Pedidos próprios ou lista central |
| GET `/orders/:id` | `{order,events,entitlement}` |
| POST `/orders/:id/simulate` | `{eventId,status?}` → `{order,applied,replay,simulated:true}` |

Faturamento central: `/api/backoffice/billing/orgs/:orgId`. Leitura do administrador parceiro: `/api/billing`.

| Método e sufixo | Uso |
| --- | --- |
| GET `/contracts` | `{items:[{id,effectiveFrom,revision,licenses,credits,extraTerms,createdAt}],coverage:{trackedSince}}` |
| POST `/contracts/preview` (central) | `{licenses,credits,quantity,schools,students}` → `{consumption,licenses,totalCents}` |
| POST `/contracts` (central) | `{effectiveFrom:'YYYY-MM',expectedRevision,licenses,credits,extraTerms?}` → 201 `{contract}` |
| GET `/preview?month=YYYY-MM` | `{preview,closedInvoiceId}`, reutiliza snapshot se fechado |
| POST `/close` (central) | `{month}` → 201 novo/200 replay `{invoice,replay}` |
| GET `/invoices?page&pageSize` | Faturas com estado `open|settled`, valores e snapshot |
| GET `/invoices/:id` | `{invoice,adjustments,settlement}` |
| POST `/invoices/:id/adjustments` (central) | `{clientKey,amountCents,reason}` → 201 `{adjustment}` |
| POST `/invoices/:id/settle` (central) | `{eventId}` → `{invoice,replay,simulated:true}` |

`licenses={organizationCents,schoolCents,studentCents}`. `credits` e `priceTable` usam `{mode:'volume'|'progressive',tiers:[{from,to,unitPriceCents}]}`; faixa final `to:null` e demais faixas contíguas inclusivas.

Integração do aplicativo: `registerCommerce(app,{defaultPaymentScenario:(orgId)=>status})` e `registerBilling(app,{now:(orgId)=>Date})`. Callbacks são opcionais; padrões são pagamento aprovado e relógio real. Ambos resolvem o tenant antes do callback e o executam antes da transação, para não requisitar outra conexão enquanto seguram lock. Um evento sem status mantém fingerprint da intenção original; mudar política depois não altera seu replay.

A função exportada `closeBillingPeriod(db,{orgId,actorId,month,now?})` é compartilhada com agendamento. Exige operador ativo no backoffice no instante da transação. `previewBillingInTransaction(client,{orgId,month,now?})` reutiliza a apuração com cliente já transacional.

## Interface e verificação

`BillingPage({central?:boolean})`, em `client/billing.tsx`, contém proteção de área e layout. Uso sugerido: `/backoffice/billing` com `central`, `/admin/billing` sem `central`. Operador escolhe parceiro, publica valores por vigência, simula cálculo, consulta prévia, fecha, ajusta e liquida. Administrador parceiro lê contrato/prévia/faturas. Campos monetários usam reais na interface e conversão decimal exata para centavos; erro 409 preserva o formulário e pede recarregar versão explicitamente. Não há rotas globais adicionadas pelo módulo.

Evidência de backend: 41 testes do núcleo, 15 de faturamento e 22 independentes de comércio. Faturamento cobre exemplo R$1.440, cortes exatos, histórico desconhecido, aceite, elegibilidade, consumo líquido, vigência, estorno tardio, alocação progressiva, ajuste/saldo a favor, liquidação/replay, papéis/isolamento, CAS e fechamento compartilhado. Comércio cobre snapshots, eventos concorrentes, concessão+matrícula atômicas, revogações durante lock e crédito derivado da versão. Os testes usam schemas e arquivos temporários isolados. Verificações finais da UI e integração são registradas na revisão de fase; este documento não declara aprovação independente ou gate remoto.

Smoke visual isolado de faturamento: formulário contratual/cálculo/publicação, prévia/fechamento, ajuste negativo convertido exatamente para -1025 centavos e liquidação passaram com fixtures HTTP sintéticas. Larguras 320, 375, 768 e 1440 sem transbordamento da página e sem erro JavaScript. A tabela financeira rola horizontalmente em telas estreitas. Esse smoke não substitui E2E integrado com a API real.
