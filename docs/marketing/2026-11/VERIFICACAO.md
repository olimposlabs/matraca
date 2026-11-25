# Verificação editorial e estrutural da entrega

Conferência da edição ampliada em 25/11/2026. Este registro cobre documentos e leitura navegável; não representa teste de campanha nem comprovação de resultados de aprendizagem ou vendas.

## Inventário conferido

| Biblioteca | Vídeos | Takes | Carrosséis | Páginas | Posts únicos | Legendas |
| --- | --- | --- | --- | --- | --- | --- |
| Base direta, IDs 01–30 | 30 | 180 | 30 | 180 | 30 | 90 |
| Vendedores, IDs 31–50 | 20 | 120 | 20 | 120 | 20 | 60 |
| Base white label, IDs 01–30 | 30 | 180 | 30 | 210 | 30 | 90 |
| Equipes comerciais, IDs 31–50 | 20 | 120 | 20 | 140 | 20 | 60 |
| **Total** | **100** | **600** | **100** | **650** | **100** | **300** |

A extensão acrescenta 120 peças: 20 vídeos, 20 carrosséis e 20 posts para cada novo segmento. Cada frente passa a 150 peças, 50 de cada formato. Os dois arquivos das bibliotecas originais foram comparados por hash com a edição anterior e permaneceram idênticos.

Foram conferidos os 300 IDs únicos, sem lacunas nas sequências 01–50 de cada formato e frente. Todas as peças têm legenda e três hashtags propostas. As 650 páginas de carrossel têm descrição alternativa individual; os 100 estáticos têm descrição alternativa. Instruções de arte são briefings, não imagens renderizadas.

Os 600 takes têm numeração de 1 a 6, intervalos contínuos, início em zero e duração positiva. As durações declaradas coincidem com as linhas de tempo. Os vídeos da base direta têm 40–48 segundos; os da base white label, 48–52; os novos de vendedores, 45–48; os novos empresariais, 48. A estimativa textual das falas ficou abaixo de 180 palavras por minuto em todas as bibliotecas; nas duas novas, abaixo de 165. A conta não substitui ensaio com pausas, ações, dicção e interpretação.

## Calendários e navegação

O calendário completo combinado contém os 300 IDs uma vez em 50 semanas. Cada frente independente contém 150 IDs uma vez em 25 semanas. O sprint comercial contém os 120 novos IDs uma vez em 20 semanas combinadas, ou 60 por segmento em 10 semanas independentes. São alternativas de distribuição das mesmas peças. A ordem relativa dos temas originais foi preservada, com os novos temas comerciais intercalados desde o início.

Links locais e âncoras foram conferidos. As referências técnicas do produto apontam para a main consultada, `2a7b728`; links editoriais apontam para os documentos desta edição. A verificação também está incorporada ao HTML, evitando encaminhamento a uma versão do repositório que ainda não continha a pasta de marketing.

O HTML foi exercitado em Chromium a partir de arquivo local, nas larguras de 1440, 390 e 320 pixels. Foram verificados os 300 cartões; filtros por frente, formato e segmento; cruzamento de filtros; estado sem resultados; busca com e sem acentos; abertura e recolhimento; acesso por âncora a uma peça nova; preparação para impressão de todo o conteúdo. Segmentos retornam 180 peças de base, 60 de vendedores e 60 de equipes; cada novo segmento retorna 20 por formato.

Não foram encontrados IDs duplicados, âncoras internas ausentes, erros JavaScript ou dependências remotas de apresentação. Não houve transbordamento horizontal da página; tabelas extensas têm rolagem própria. Capturas de desktop e celular foram inspecionadas. O arquivo funciona sem conexão para consultar o material; fontes externas exigem internet.

O HTML é uma compilação desta edição. Alterar um Markdown não atualiza automaticamente a compilação; reconciliar as versões antes de compartilhar uma nova edição.

## Revisão editorial

A revisão original incluiu planos, operação e amostras das duas bibliotecas de base. Na direta, examinou vídeos 01–10, carrosséis 21–30 e estáticos 01–10. Na white label, examinou vídeos 01/05/10/15/20/25/30, carrosséis 01/10/20/30 e estáticos 01/10/20/30. Esses arquivos foram preservados nesta extensão.

Na ampliação, uma revisão independente examinou estratégia, calendário, distinção entre contratação individual e programa empresarial, CTAs e estágio real do produto. A amostra de vendedores cobriu vídeos, carrosséis e posts 31/35/40/45/50. A revisão empresarial examinou os mesmos IDs e os exemplos numéricos; a conferência estrutural automatizada cobriu as 300 peças.

A revisão corrigiu falas rápidas, formatação de identificadores e referências, contagem de destinatários em uma composição e exemplos de consumo. A reserva de até 48 créditos na estratégia depende das durações de cada pedido. O exemplo uniforme W-V50 resulta em 160 + 100 = 260 créditos. O exemplo por funções W-C50 resulta em 96 + 64 + 100 = 260, com durações exatas explicitadas. Os cálculos representam cenários de planejamento, sem tabela comercial ou promessa de retorno.

A campanha diferencia prática individual e organização do desenvolvimento da equipe. Uso corporativo não pressupõe revenda white label. Os conteúdos distinguem integração real local, demonstrações editoriais identificadas e validações pedagógica/humana pendentes; não anunciam CRM integrado, gravação automática de chamadas ou interlocutor de IA ao vivo.

## Fontes, limites e escopo

O baseline original registra fontes oficiais de 10 ofertas com comunicação pública acessível e uma referência histórica. O complemento comercial aprofunda Yoodli e adiciona Second Nature. Funcionalidades concorrentes são descritas como anunciadas, sem teste contratado. As limitações de acesso direto ao Instagram estão explícitas; não há métricas concorrenciais inventadas.

Não foram realizados gravação, design final das mídias, publicação em rede social, envio comercial, compra de anúncios ou deploy. Preços, orçamento e desempenho estão separados entre exemplos documentados, cenários propostos e resultados ainda não observados.

O escopo versionado é documental, restrito a `docs/marketing/2026-11`. Aplicação, dependências e infraestrutura não foram alteradas. A validação local se concentrou em integridade documental, revisão editorial e funcionamento do leitor; a suíte da aplicação não foi reexecutada localmente. O resultado do workflow do repositório deve ser consultado na PR para o SHA correspondente.
