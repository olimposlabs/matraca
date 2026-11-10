# Créditos e cobrança do Matraca

Requisitos de produto definidos pelo fundador durante o discovery. Este documento concentra as regras de consumo, concessão, aquisição e cobrança de créditos. Valores monetários e quantidades usados nos exemplos são referências configuráveis. Os preços comerciais finais dependem da medição dos custos e dos termos de cada contrato.

## Unidade de consumo

O produto usará provisoriamente a unidade **crédito** para medir o consumo de avaliações de vídeo. Cada organização poderá personalizar o nome apresentado ao aluno, incluindo as formas singular e plural. A denominação escolhida mantém a equivalência de um crédito para cada minuto, ou fração de minuto, de vídeo avaliado.

### Arredondamento por pedido

Para uma duração válida e positiva, o consumo é calculado por pedido de avaliação usando `créditos = teto(duração_em_segundos / 60)`. O arredondamento ocorre sempre para cima, sobre a duração verificada do vídeo.

| Duração do vídeo | Créditos consumidos |
| --- | --- |
| 30 segundos | 1 |
| 1 minuto | 1 |
| 1 minuto e 1 segundo | 2 |
| 1 minuto e 59 segundos | 2 |
| 2 minutos | 2 |
| 5 minutos | 5 |
| 5 minutos e 1 segundo | 6 |

Dois pedidos separados de 30 segundos consomem dois créditos ao todo. A medição preserva o arredondamento de cada pedido. Arquivos sem duração válida precisam ser tratados antes da confirmação de consumo.

O limite de duração da atividade e o saldo necessário para avaliá-la são configurações relacionadas. Os exercícios do [plano de ensino](PLANO_DE_ENSINO.md) usam 30 segundos e até 5 minutos. Recompensas maiores permitem planejar novas atividades e durações, conforme os limites publicados pela organização. O exemplo de 5 minutos e 1 segundo demonstra o cálculo para uma atividade que aceite essa duração.

### Recompensas no programa de ensino

O editor do curso permitirá definir a quantidade de créditos concedida ao aluno ao completar uma aula, um módulo ou o curso. Os valores abaixo são exemplos fornecidos pelo fundador e permanecem configuráveis.

| Evento de concessão | Exemplo de recompensa | Capacidade de avaliação ilustrativa |
| --- | --- | --- |
| Conclusão de aula | 1 crédito | Um pedido de até 1 minuto, incluindo o exercício de 30 segundos |
| Conclusão de módulo | 5 créditos | Um pedido de até 5 minutos |
| Conclusão de curso | 20 ou 30 créditos | Saldo para avaliações posteriores, respeitando o arredondamento por pedido e os limites de duração |

Os critérios de conclusão e o momento de liberação devem permitir que o aluno obtenha os créditos necessários antes de solicitar a avaliação correspondente. A definição desses marcos, a concessão para a apresentação inicial e as recompensas por repetir aulas, módulos ou cursos, inclusive após mudanças de versão, estão a definir.

### Direcionamento e histórico da avaliação

Cada pedido terá um objetivo de avaliação e o contexto pedagógico pertinente. Para atividades de curso, isso inclui o tema da aula ou revisão, a versão dos critérios, o nível observado, as metas do aluno e o histórico relevante de avaliações e mentorias. A seleção do histórico respeitará a organização em que o aluno está autenticado e as permissões de acesso.

O relatório deve manter identificáveis o direcionamento usado, a duração avaliada, os créditos consumidos e a atividade de origem. O saldo e as movimentações do aluno pertencem à organização correspondente, em continuidade ao isolamento definido para o produto.

### Medição de uso e monetização

As concessões registram créditos disponibilizados ao aluno. O consumo registra créditos utilizados em pedidos de avaliação e compõe a parcela variável mensal da cobrança white label. Os dashboards deverão permitir acompanhar créditos concedidos, adquiridos, consumidos e saldo por aluno e organização, junto dos minutos efetivamente processados e dos custos técnicos medidos.

Os pontos do leaderboard e as medalhas mantêm sua função de reconhecimento pedagógico. Os créditos representam capacidade de solicitar avaliações. O nome personalizado pelo parceiro se aplica à unidade de consumo.

Cada movimentação deverá identificar organização, aluno, quantidade, origem e pedido ou evento associado. A repetição técnica de um mesmo evento deve preservar uma única concessão ou consumo, conforme os princípios de idempotência do projeto. Os preços finais, a expiração, as regras de transferência de saldo e o tratamento de falhas, cancelamentos e reavaliações estão a definir. As modalidades de aquisição e cobrança estão descritas nas seções seguintes. A aplicação da unidade às avaliações apenas de áudio também precisa ser definida.

## Clientes diretos do Matraca

O cliente direto poderá comprar um curso com uma quantidade configurável de créditos incluídos. O curso poderá liberar esses créditos na aquisição ou conforme o avanço, de acordo com sua configuração. O aluno também poderá comprar pacotes de créditos extras.

O backoffice Matraca poderá conceder manualmente créditos ou pacotes a usuários diretos. O registro deve identificar beneficiário, quantidade, origem e responsável pela concessão. O catálogo de pacotes e suas faixas de preço serão configuráveis pelo time Matraca.

Créditos provenientes do curso, de compras extras ou de concessões manuais precisam conservar sua origem no histórico. As regras de validade e a ordem de utilização desses saldos estão a definir.

## Créditos extras no white label

O administrador da organização poderá conceder ou adquirir créditos adicionais para alunos específicos. A organização definirá se cada escola também poderá realizar essas operações de forma independente ou se a atribuição ficará centralizada no administrador.

| Papel | Capacidade prevista |
| --- | --- |
| Backoffice Matraca | Configurar as condições comerciais e a tabela de preços do contrato da organização |
| Administrador da organização | Atribuir ou adquirir créditos extras para alunos da organização e definir a autonomia das escolas |
| Gestão da escola | Atribuir ou adquirir créditos para seus alunos conforme as permissões dadas pela organização |
| Aluno white label | Usar o saldo recebido dentro das regras da organização. A compra diretamente pelo aluno depende de definição própria |

A autonomia de uma escola para adquirir créditos precisa identificar o responsável financeiro. A escolha entre cobrança direta à escola e inclusão na fatura central da organização está a definir.

Na cobrança mensal por consumo, entram os créditos efetivamente utilizados em avaliações, inclusive os obtidos pelo curso, por concessão administrativa, por premiação ou como extras. O histórico deverá distinguir a disponibilização de saldo do seu consumo. Caso a aquisição de extras envolva pagamento antecipado, a conciliação com a cobrança mensal precisa ser definida para reconhecer esse pagamento uma única vez.

## Créditos como prêmio do leaderboard

Cada organização poderá configurar créditos como premiação de suas classificações. O exemplo do fundador concede 3 créditos ao primeiro colocado, 2 ao segundo e 1 ao terceiro. Quantidades, posições premiadas, classificação abrangida e periodicidade são configuráveis.

O fechamento de cada premiação deverá identificar organização, ranking, período, classificação e aluno beneficiado. O processamento repetido do mesmo resultado preserva uma única concessão. O momento de apuração e a regra para empates estão a definir.

Os pontos que determinam a classificação e o saldo de créditos têm funções próprias. A premiação converte um resultado de ranking em uma concessão identificada de créditos, conforme a política publicada pela organização.

## Licenciamento e faturamento white label

O contrato poderá combinar componentes fixos mensais e consumo variável de créditos. Todos os valores serão configuráveis no cadastro da organização, pelo backoffice Matraca, para refletir os termos contratados.

| Componente | Referência ilustrativa informada pelo fundador |
| --- | --- |
| Licença da organização | R$ 1.000 por mês |
| Licença por escola | R$ 100 por escola por mês |
| Licença por aluno | R$ 1 por aluno por mês |
| Avaliações | Créditos consumidos no período, valorizados pela tabela contratada |

A unidade por participante dessa proposta é o aluno. O modelo descrito contempla professores sem um componente mensal específico por professor. As regras de contagem de alunos com múltiplas turmas, papéis ou transferências precisam ser definidas antes da implementação.

### Competências do fechamento

No fechamento de um mês, a fatura reúne o licenciamento do mês seguinte e o consumo do mês que se encerra. Assim, um fechamento de novembro pode reunir as licenças de dezembro e os créditos consumidos em novembro.

O cálculo conceitual é `licença da organização + quantidade de escolas cobráveis × preço por escola + quantidade de alunos cobráveis × preço por aluno + valor dos créditos consumidos`. Cada parcela deve indicar a competência e a tabela contratual aplicável.

Exemplo inteiramente hipotético, com cobrança integral das licenças de dezembro para uma organização, três escolas e 50 alunos elegíveis. Adotando os valores ilustrativos acima, 100 créditos consumidos em novembro e uma única faixa de R$ 0,90 por crédito, o fechamento seria composto por R$ 1.350 de licenciamento e R$ 90 de consumo, totalizando **R$ 1.440**. A faixa única serve apenas para ilustrar a conta.

A data de corte, os critérios de elegibilidade e a proporcionalidade para entradas, saídas e cancelamentos estão a definir. Mudanças contratuais deverão identificar sua vigência, preservando os valores aplicáveis aos períodos já apurados.

## Preços por faixas

O catálogo direto do Matraca e cada contrato white label poderão ter tabelas de preço por quantidade. No atendimento direto, as faixas podem compor os pacotes adquiridos. No white label, a tabela será definida no cadastro da organização, conforme o contrato.

O fundador sugeriu como referência uma faixa de **10 créditos ou mais a R$ 0,90 por crédito**. Os valores para as demais quantidades e o modo de aplicar a faixa ainda precisam ser definidos. Os preços finais serão ajustados após a investigação do custo de avaliação por minuto.

Uma única faixa, cobrindo todas as quantidades permitidas, representa preço unitário constante. Sua vigência seguirá o contrato, inclusive quando o preço for acordado por prazo indeterminado.

Para publicar uma tabela, deverão estar definidos os limites de cada faixa, o preço unitário, a quantidade usada como referência e o modo de aplicação. Falta escolher entre os modos abaixo.

- **Por volume.** A faixa atingida determina o preço de todas as unidades da quantidade apurada.
- **Progressivo.** Cada parcela da quantidade recebe o preço da faixa em que se encontra.

Também precisa ser definida a base da quantidade no white label, como consumo mensal agregado da organização ou outra base contratual. A tabela vigente e a quantidade apurada devem acompanhar o registro da cobrança.

## Pontos a definir

| Tema | Decisão pendente |
| --- | --- |
| Preços finais | Valores após medição dos custos, tamanho dos pacotes e termos contratuais |
| Aplicação das faixas | Por volume ou progressiva e quantidade de referência em cada modalidade |
| Contagem de licenças | Alunos e escolas elegíveis, múltiplos vínculos, data de corte e proporcionalidade |
| Extras no white label | Responsável financeiro, eventual pagamento antecipado e conciliação com o consumo mensal |
| Jornada inicial | Saldo para diagnóstico e critérios de liberação das recompensas antes das avaliações |
| Repetição de atividades | Novas concessões após repetir aulas, módulos, cursos ou versões |
| Saldo | Expiração, ordem de utilização por origem e regras de transferência |
| Avaliações | Débito, falhas, cancelamentos, reavaliações e aplicação da unidade a áudio |
| Premiações | Período, escopo do ranking, empates e momento de fechamento |
| Pagamentos | Cobrança dentro da plataforma no piloto e formas de pagamento |
