# Operação local do piloto

Acesse `/backoffice/operations` com o operador do Matraca. Selecione a organização e, quando disponível, escola, aluno e período. O painel usa o instante de conclusão da avaliação para somar minutos e o instante do lançamento para contabilizar créditos. O filtro por escola usa o vínculo vigente no instante do evento. O saldo representa a carteira atual, enquanto as contagens de uso respeitam o período selecionado.

O painel separa dados do produto de valores simulados. O custo estimado da avaliação é a soma das durações verificadas em minutos multiplicada pelo valor configurado em centavos por minuto, com arredondamento ao centavo para exibição. Pedidos e faturas representam resultados do simulador de pagamento. O extrato é a fonte de créditos consumidos, reservados e estornados.

## Simulações e limites

As preferências da operação são versionadas por organização. Atualize a revisão exibida antes de salvar se outro operador tiver alterado a mesma configuração. O cenário padrão de avaliação ou checkout vale quando o usuário seleciona o cenário configurado. E-mail suprimido simula uma solicitação aceita sem mensagem. E-mail com falha devolve erro local. O relógio financeiro afeta cálculo e fechamento de competência.

Os limites de gravação, solicitações por hora, avaliações em andamento e concessão manual são reavaliados no servidor. Tentativas rejeitadas, falhas e reservas antigas aparecem nos indicadores com a auditoria disponível ao operador.

## Recuperação

1. Se um relatório demora, verifique o estado do job, a tentativa e a validade da execução. Um job com execução vigente segue com o worker atual.
2. Reenfileire um job elegível com reserva ativa pela aba Jobs. O pedido mantém a identidade e a reserva, e o worker retoma o processamento.
3. Na aba Reservas, libere uma reserva elegível de pedido órfão, falho ou cancelado. A liberação aparece no histórico e pode ser repetida com segurança.
4. Consulte a auditoria para verificar autor, organização e identificadores da intervenção. Se o job ou a reserva mudar durante a ação, recarregue a página e confira o novo estado.

## Fechamento

Na tela Faturamento, consulte a prévia, confirme a competência e feche. A mesma função transacional pode ser chamada por um job local.

```sh
npm run billing:close -- --org parceiro --month 2026-11
```

O comando usa o operador ativo de demonstração por padrão. Passe `--operator` para selecionar outro operador pelo e-mail. Repetir uma competência fechada devolve o mesmo identificador e informa que o fechamento já existe. O comando pode ser invocado por um agendador quando houver infraestrutura para isso. O piloto executa sob demanda.
