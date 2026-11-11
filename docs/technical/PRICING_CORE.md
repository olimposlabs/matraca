# Núcleo puro de preços e demonstrativo — F12

Estado: núcleo de domínio implementado e utilizado pelos adaptadores de comércio e faturamento descritos em [COMMERCE.md](COMMERCE.md). Estes dois módulos puros não consultam banco, relógio, rede ou variáveis de ambiente. Não alteram a carteira.

## Contratos de cálculo

`server/pricing.ts` exporta:

| Função | Entrada e saída |
| --- | --- |
| `validatePriceTable` | `{mode:'volume'|'progressive',tiers:[{from,to,unitPriceCents}]}` → cópia validada |
| `priceCredits` | Quantidade inteira e tabela → `{mode,quantity,totalCents,lines}` |
| `priceMonthlyLicenses` | `{organizationCents,schoolCents,studentCents}` e `{schools,students}` → parcelas e total |
| `multiplyCents`, `sumCents` | Inteiros não negativos → centavos seguros, com intermediários `BigInt` |

Faixas têm início e fim inclusivos. Começam em 1, estão ordenadas e contíguas, sem sobreposição. A última faixa obrigatoriamente usa `to:null`; não há preenchimento ou ordenação automática de uma tabela inválida. A faixa única `{from:1,to:null,...}` representa preço constante. Preço zero é permitido; preço negativo ou fracionário é rejeitado.

No modo `volume`, a faixa atingida precifica a quantidade inteira e gera uma parcela. No modo `progressive`, cada faixa utilizada gera sua parcela. Quantidade zero custa zero e não gera parcelas, mas ainda exige tabela válida. Preços por volume podem reduzir o total na passagem de uma faixa; o núcleo aplica a modalidade contratada, sem transformar a tabela em progressiva ou impor monotonicidade não solicitada.

Valores monetários externos e resultados usam números inteiros em centavos de BRL. Multiplicações e somas usam `BigInt`, convertendo o resultado apenas se não exceder `Number.MAX_SAFE_INTEGER`. Frações, negativos, `NaN`, infinito e números não seguros são rejeitados com `PricingError`; não há arredondamento de moeda em ponto flutuante.

## Snapshot e competências

`server/billing-preview.ts` exporta:

| Função | Responsabilidade |
| --- | --- |
| `validateMonth`, `nextMonth` | Validar `YYYY-MM` e avançar inclusive na virada de ano |
| `snapshotLicenses` | Consolidar candidatos de uma organização no corte, deduplicando IDs |
| `resolveContract` | Selecionar última versão vigente para organização e competência |
| `buildInvoicePreview` | Calcular demonstrativo com licença seguinte, consumo líquido anterior, linhas e cópias dos contratos/snapshot |

Uma versão contratual contém `{id,orgId,effectiveFrom,licenses,credits}`. A vigência é mensal e inclusiva. IDs duplicados, duas versões com a mesma vigência, organização divergente ou falta de contrato vigente são erros. A tabela do consumo é resolvida pela competência encerrada; os valores de licença, pela competência seguinte. Portanto, um contrato publicado para dezembro não reprecifica o consumo de novembro.

O snapshot identifica `orgId`, `closingMonth`, `licenseMonth`, `timezone:'America/Sao_Paulo'`, `schoolIds` e `studentIds`. Conta escolas ativas e usuários ativos com papel de aluno e convite aceito. Professores sem papel de aluno, convites pendentes e usuários suspensos/arquivados não contam. O mesmo aluno com vários papéis ou várias linhas de turma conta uma vez. Candidatos duplicados com estados contraditórios são rejeitados.

**Fronteira de integração:** os candidatos precisam representar o estado persistido no encerramento do mês de São Paulo. O núcleo não reconstrói o passado a partir do estado atual nem determina sozinho o instante UTC desse corte. A apuração transacional de `server/billing.ts` seleciona o estado elegível a partir do histórico observado da migração 012 e fornece `accepted` a partir de evidência persistida do aceite, excluindo entradas posteriores ao corte. Copiar a lista atual depois do corte sem histórico suficiente não satisfaz esse contrato.

O demonstrativo recebe `{consumedCredits,refundedCredits}` referentes ao consumo concluído da própria competência, calcula o líquido antes de aplicar a tabela mensal e devolve as duas quantidades brutas para conferência. Créditos concedidos, comprados ou reservados não entram nesses contadores. O total soma organização, escolas, alunos e parcelas do consumo; não há proporcionalidade de licenças.

O exemplo de três escolas, 50 alunos, licenças de R$ 1.000 + R$ 100/escola + R$ 1/aluno e 100 créditos líquidos a R$ 0,90 gera **144.000 centavos**: 135.000 de licenças de dezembro e 9.000 de consumo de novembro.

## Fronteiras entre núcleo e integração

- O núcleo retorna cópias dos contratos, faixas e listas de IDs. O fechamento em `billing.ts` persiste essas cópias junto das linhas, total e competências; a migração 012 impõe imutabilidade e unicidade por organização/período.
- Estornos que excedam o consumo da competência são rejeitados neste núcleo. A integração associa o estorno de consumo já faturado a seu valor monetário originalmente alocado, aplicando-o uma vez como ajuste de competência posterior. O total pode ser negativo; não há truncamento silencioso.
- Autorização, busca do ledger, corte transacional, histórico elegível, publicação, eventos de pagamento e liquidação pertencem aos adaptadores documentados em COMMERCE.md, não às funções puras.
- Não há valores fiscais, impostos ou juros presumidos. Este é demonstrativo do piloto, não documento fiscal.

## Evidência local

`tests/pricing.test.ts`: **41 testes passaram**, sem banco ou serviços externos. Cobertura de limites 0/1/9/10/11/99/100/101, volume/progressivo, faixa única, lacunas/sobreposições, frações/overflow, deduplicação e elegibilidade, separação de organizações, vigência por competência, cópias independentes, estorno líquido e exemplo de R$ 1.440. Lint dos módulos/suíte e TypeScript passaram.

A evidência acima se restringe ao núcleo puro. A validação dos adaptadores e da interface é registrada separadamente; ela não representa aprovação independente ou gate remoto da F12.
