# F12 · loja e checkout no portal

## Fluxos implementados

`CommercePage({mode})` atende o aluno direto em `/app/store` e o operador em `/backoffice/commerce`. O aluno de parceiro recebe orientação para consultar sua escola; a loja avulsa é exclusiva da organização Matraca.

O aluno confere uma oferta, cria um pedido e revisa o valor final persistido antes de simular o pagamento. A simulação identifica explicitamente que nenhum valor real será cobrado. O cenário inicial usa a configuração da organização: o cliente omite `status` para o servidor resolver o padrão. Também é possível escolher pendente, aprovado, recusado ou cancelado para testar o piloto.

A mesma chave de pagamento é mantida ao repetir uma tentativa com os mesmos dados após erro de transporte. Confirmações atualizam o histórico do pedido e mostram os acessos efetivamente liberados. O aluno pode consultar a carteira ou voltar à sua jornada; não há concessão otimista de créditos no navegador.

O backoffice cadastra pacotes com faixas de preço em volume ou progressivas. Uma prévia calculada no servidor mostra preço total e subtotais. Ofertas de curso selecionam uma versão publicada; os créditos de aquisição vêm dessa versão, sem campo de override. Salvar produz rascunho; publicar e arquivar são ações explícitas. Revisões protegem alterações concorrentes e pedidos existentes preservam o snapshot aceito.

A integração também registra `/admin/billing` e `/backoffice/billing` com `BillingPage`. O servidor oferece `AppOptions.billingNow(orgId)` como injeção interna do relógio financeiro de testes; esse valor não é parâmetro aceito no HTTP.

## Validação executada

```sh
npm run build
npm exec tsx -- scripts/check-commerce-ui.ts
```

O roteiro executa Chromium contra o Fastify e PostgreSQL reais na porta 3012, com schema exclusivo e arquivos temporários. Identidades, curso e sessões são fixtures sintéticas. Somente o pagamento externo é simulado. A limpeza encerra navegador/servidor e remove exclusivamente o schema e os arquivos criados pelo roteiro.

Jornadas observadas:

- criação de pacote, edição das faixas, prévia em volume de R$ 9,00 e progressiva de R$ 9,90, rascunho e publicação;
- oferta de curso com versão selecionada e sete créditos derivados, sem ajuste manual desse número;
- catálogo real do aluno, criação de pedido e confirmação posterior;
- pagamento pendente sem benefício; aprovação com resposta de rede intencionalmente perdida após o commit; repetição da mesma intenção recupera o resultado e mantém uma única concessão;
- compra de curso cria matrícula na versão ofertada e concede os sete créditos uma única vez;
- cenários recusado e cancelado não aumentam a carteira;
- saldo final de 17 créditos após duas compras aprovadas, sem aumento nas outras duas;
- histórico central identifica o aluno pelo nome, arquivo remove a oferta de novas compras e aluno não acessa o backoffice;
- cenário padrão do curso envia o evento sem `status`, preservando a configuração do simulador no servidor;
- layout de 390 px: PNG com largura exata e ausência de rolagem horizontal; nenhuma exceção JavaScript de página.

Capturas locais sintéticas, inspecionadas visualmente: `.data/phase12-commerce-catalog.png`, `phase12-commerce-admin.png`, `phase12-commerce-checkout.png` e `phase12-commerce-mobile.png`. Elas são ignoradas pelo Git.

TypeScript e lint dos arquivos alterados passaram. A revisão de frontend feita por outro agente apontou o cenário inicial fixo; ele foi corrigido para respeitar o padrão da organização. A revisão independente de faturamento e os 78 testes de comércio, faturamento e preços passaram em rodada separada. O build concluiu com aviso de tamanho do bundle principal; não houve falha de compilação.

A evidência de navegador é Chromium local, sem afirmar teste já realizado em Safari ou Firefox. As chaves de criação e pagamento permanecem no componente durante a tentativa; uma recarga da página exige consultar o histórico para recuperar pedidos, sem continuidade automática da intenção ainda aberta no formulário.
