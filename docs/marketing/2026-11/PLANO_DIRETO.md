# Plano de marketing — vendas diretas Matraca

Proposta de trabalho de 25/11/2026, ampliada para vendedores. Mercado brasileiro, comunicação em português, aquisição pelo Instagram. Decisões de campanha abaixo são recomendações para teste, não resultados observados. Este documento orienta 165 peças: as 90 de [CONTEUDO_DIRETO.md](CONTEUDO_DIRETO.md) e as 75 novas de [CONTEUDO_VENDEDORES.md](CONTEUDO_VENDEDORES.md). A [campanha comercial](EXTENSAO_COMERCIAL.md) detalha a prioridade de vendas; operação e calendários são comuns.

## 1. Objetivo e ponto de partida

Construir uma marca que associe o Matraca ao ato de praticar uma fala importante, identificar uma prioridade e tentar novamente. O objetivo comercial futuro é vender cursos e capacidade de avaliação a pessoas físicas; o objetivo imediato é descobrir quais situações geram demanda qualificada e recrutar participantes compatíveis com a capacidade do piloto.

O piloto local está tecnicamente implementado, mas a homologação manual final permanece pendente. A main consultada em `2a7b728` possui adaptadores mock e OpenAI real. O registro de 24/11/2026 documenta teste técnico real com fala sintética em português e vídeo sem pessoas; a qualidade pedagógica e a homologação humana não foram declaradas aprovadas. O mock permanece disponível: suas notas e trechos são simulações determinísticas. Esta biblioteca escolhe demonstrações simuladas rotuladas como material editorial; uma captura real precisa identificar o modo e usar resultado efetivo de ambiente autorizado. Pagamentos do piloto também são simulados. Resultados do mock devem permanecer identificados como simulados; nem eles nem o teste técnico comprovam eficácia pedagógica. O curso com 12 módulos, 36 aulas e 12 revisões representa uma proposta pedagógica a validar. A existência do currículo não comprova transformação de desempenho.

Há três momentos comerciais distintos:

| Momento | Oferta e resultado esperado | CTA permitido | Condição para avançar |
| --- | --- | --- | --- |
| Agora: descoberta | Conteúdo útil, roteiro de prática e conversa sobre interesse | “Envie TREINO”, salvar, compartilhar, responder sobre uma situação | Capacidade de atendimento e material de resposta preparado |
| Piloto supervisionado | Participação com escopo, acompanhamento, limitações e condições explícitos | “Quero conhecer o piloto” | Ambiente e atendimento disponíveis; modo de avaliação e limites explicitados |
| Venda pública | Curso e créditos conforme catálogo validado | “Conheça o curso e as condições” | Homologação, qualidade do provedor calibrada para o uso, publicação autorizada, suporte, preço e pagamento reais verificados |

O calendário começa na data escolhida para a campanha. Não pressupõe que a fase comercial terá sido liberada em determinada semana. A biblioteca mantém CTAs utilizáveis no estágio atual; a seção de conversão explica a adaptação posterior.

## 2. Posicionamento e mensagem

**Assinatura principal:** “Pratique a fala que você precisa usar.” A formulação “a fala que importa para você” é uma variação de apoio, sem substituir a assinatura nas peças de apresentação.

**Explicação curta para o estágio atual:** “O Matraca está desenvolvendo uma jornada de prática de oratória com avaliação por IA. Conheça o piloto e comece por um objetivo de fala.”

**Mensagem após liberação comercial:** “Defina a situação, pratique sua fala, examine o feedback e escolha o próximo treino.” Usar somente os recursos efetivamente liberados na oferta da pessoa.

O benefício a comunicar é tornar a prática específica e acompanhável. Clareza, organização, ritmo e adaptação são comportamentos observáveis; promoção, aprovação em entrevista, venda e vitória em processo dependem de fatores que o produto não controla. Segurança para falar pode ser uma experiência relatada pelo usuário, sem ser anunciada como efeito garantido ou tratamento de ansiedade.

Tom: acolhedor, direto, inteligente, com humor de situações profissionais. O nome Matraca permite leveza, mas a marca não deve sugerir que o objetivo é falar mais, atropelar alguém ou eliminar sotaques. Frase de apoio: “Uma ideia clara. Uma tentativa. Um próximo passo.” Evitar fingir autoridade clínica, jurídica ou acadêmica em cenas encenadas.

## 3. Públicos e prioridades

Produzir uma biblioteca ampla não exige abrir todas as frentes de aquisição de uma vez. A ampliação coloca vendedores entre as prioridades de aquisição, com uma campanha própria: começar por prospecção B2B e venda consultiva de serviços/varejo, testando situações concretas. Na cadência completa, intercalar essa pauta com líderes em início de gestão e especialistas que explicam assuntos complexos; no sprint comercial, concentrar o feed nas duas verticais de vendas. Advogados, médicos e professores continuam no acervo; a verba só se expande após sinais de interesse qualificado. Essa prioridade é uma decisão de campanha, não uma conclusão de eficácia comparativa.

| Público | Situação que dispara a busca | Dor formulada pelo público | Conteúdo de entrada | Evidência de interesse | Objeção e resposta |
| --- | --- | --- | --- | --- | --- |
| Líder de equipe | Reunião, alinhamento, feedback | “Falo e o combinado continua confuso” | Pedido com responsável, prazo e confirmação | Relata reunião concreta nas próximas semanas | “Não tenho tempo”: começar com um recorte curto, sem prometer rapidez de transformação |
| Advogado | Explicação ao cliente, reunião, sustentação simulada | “O cliente não entende o que estou explicando” | Traduzir um conceito sem perder precisão | Escolhe cenário de comunicação, sem enviar caso real | “Preciso manter rigor”: clareza preserva condições e limites |
| Médico e outros profissionais de saúde | Orientação e exposição educativa | “Explico, mas não sei o que foi entendido” | Pergunta de checagem e linguagem acessível, em cena fictícia | Quer praticar uma explicação, sem dado de paciente | “Isso muda conduta?”: conteúdo treina expressão; não ensina decisão clínica |
| Professor/instrutor | Abertura de aula, instrução, resumo | “A turma perde o fio” | Objetivo de aula, exemplo e checagem | Descreve disciplina e audiência | “Já domino o tema”: trabalhar como o tema é apresentado |
| Vendedor/consultor | Descoberta, proposta, objeção | “Apresento tudo e não avanço” | Pergunta, síntese do problema, próximo passo | Identifica etapa comercial a ensaiar | “Quero fechar mais”: praticar comportamentos; venda não é resultado garantido |
| Empreendedor | Pitch, parceria, vídeo da empresa | “Não consigo resumir o que faço” | Problema, solução, exemplo, pedido | Escreve sua apresentação em uma frase | “Preciso parecer grande”: usar exemplos concretos sem fabricar clientes |
| Pessoa em transição de carreira | Entrevista ou apresentação pessoal | “Sei fazer, mas me enrolo para explicar” | Episódio real, ação própria, aprendizado | Identifica entrevista ou função desejada | “Tenho vergonha de gravar”: começar em ambiente privado, com limites claros |
| Universitário adulto | Seminário, TCC, início de carreira | “Decoro e travo se esqueço uma parte” | Mapa de ideias e recuperação de um ponto | Escolhe apresentação futura | “Não tenho experiência”: usar tarefa compatível com o repertório |
| Profissional técnico | Reunião com área não técnica | “Meu público não conhece os termos” | Comparar duas explicações para públicos distintos | Informa quem precisa compreender | “Simplificar distorce”: explicar termos e explicitar o que a analogia não cobre |
| Criador iniciante | Vídeo para câmera | “Regravo sem saber o que mudar” | Um objetivo por tentativa e enquadramento funcional | Quer aprender a avaliar sua própria gravação | “Preciso de equipamento”: começar com captação audível e enquadramento simples |

Não tratar timidez como defeito, sugerir diagnóstico ou hierarquizar sotaques. Pessoas com necessidades de acessibilidade devem poder informar adaptações; não anunciar compatibilidade universal antes de verificar o fluxo. Na campanha inicial, trabalhar com adultos; qualquer público menor exige planejamento específico, fora desta proposta.

## 4. Arquitetura da oferta

### Entrada gratuita de conteúdo

Entregar um roteiro de uma página, como texto ou PDF produzido a partir do bloco abaixo, sem exigir vídeo nem informações sensíveis. O pedido TREINO abre uma conversa humana. Automação de DM é uma possibilidade futura, não uma integração existente.

**Material pronto: “Sua próxima fala em quatro linhas”**

1. “Vou falar com: ____.”
2. “Quero que a pessoa compreenda: ____.”
3. “Meu exemplo será: ____.”
4. “Vou encerrar pedindo ou propondo: ____.”

Instrução final: “Grave até 30 segundos no seu próprio aparelho. Ouça uma vez e verifique se a ideia principal aparece. Escolha uma alteração e repita. Você não precisa publicar nem nos enviar a gravação.” Trata-se de exercício editorial, não avaliação do Matraca.

### Interesse no piloto

Após entregar valor, oferecer conversa sobre objetivo, disponibilidade para prática e interesse em testar o fluxo. Não prometer vagas fixas, acesso instantâneo, avaliação automática, mentoria individual ou gratuidade por tempo indeterminado. Se houver seleção, publicar critérios reais: adequação ao cenário, disponibilidade de acompanhamento e capacidade operacional.

### Oferta comercial futura

Estrutura recomendada: curso com créditos incluídos + pacotes adicionais; avaliação livre como entrada alternativa quando disponível. Não escolher preço de venda com base no custo zero do simulador. A integração real já possui telemetria; é necessário medir custo e perfil de uso representativos. Medir custo real de processamento, suporte, armazenamento, aquisição e reavaliações antes de definir margem.

Página de oferta futura deve informar: conteúdo liberado, duração/limite de cada envio, créditos incluídos, regra de arredondamento por pedido, reenvios, tipo de acompanhamento, requisitos técnicos, preço total, condições de contratação e suporte. Um vídeo de 30 segundos consome 1 crédito; dois pedidos separados de 30 segundos consomem 2. Não equiparar “um crédito” a “uma aula completa” ou “uma mentoria”.

## 5. Funil do Instagram

| Etapa | Pergunta da pessoa | Conteúdo | Próxima ação | Registro |
| --- | --- | --- | --- | --- |
| Descoberta | “Isso acontece comigo?” | Reels com cena profissional e pequena mudança de fala | Assistir/salvar/visitar perfil | Alcance, visualizações e origem por peça |
| Consideração | “O que posso tentar?” | Carrossel de método, checklist, exercício | Usar o roteiro/mandar TREINO | DMs iniciadas por peça e situação relatada |
| Confiança | “Como funciona e o que entrega?” | Bastidor e demonstração rotulada | Conhecer limitações e jornada | Perguntas, objeções, interesse em piloto |
| Qualificação | “Serve para meu caso?” | Conversa curta e formulário mínimo | Registrar interesse ou agendar conversa | Contato com consentimento e etapa no CRM |
| Ativação | “Consigo usar?” | Orientação de primeiro objetivo e primeiro treino | Completar tarefa definida no piloto | Atividade observada, dificuldade e retorno |
| Retenção | “Qual é o próximo passo?” | Uma prioridade, repetição comparável, reflexão | Retomar treino com objetivo | Retorno no período combinado |
| Receita futura | “Quero continuar” | Oferta transparente e compatível com uso | Comprar quando disponível | Compra, custo, suporte, recompra |

**Perfil proposto, a verificar disponibilidade de nome:** nome exibido “Matraca | prática de oratória”. Bio no estágio atual: “Pratique a fala que você precisa usar. Oratória para situações reais. Conheça o piloto em desenvolvimento. Envie TREINO.” Não usar domínio como destino até confirmar registro e página publicada.

Três fixados: apresentação honesta do Matraca, exercício que a pessoa pode executar, explicação do piloto. Destaques: Comece aqui; Exercícios; Como funciona; Piloto; Dúvidas; Para empresas. Identificar cenas encenadas e demonstrações no próprio conteúdo, não apenas no último slide.

Uma página de interesse, quando for criada, terá dois caminhos: “Quero praticar minha fala” e “Quero oferecer à minha organização”. Para pessoa física, pedir nome preferido, canal de retorno, contexto de uso e consentimento de contato. Não solicitar CPF, prontuário, processo, vídeo profissional confidencial ou detalhes de terceiros na etapa de marketing.

## 6. Pilares e organização editorial

Distribuição sugerida para a base original de 90 peças: 30 com reconhecimento de problema, 30 com exercício aplicável, 15 com funcionamento/limites do método, 10 com objeções e 5 com convite ao próximo passo. A extensão de 75 acrescenta 25 temas comerciais, cada um com Reel, carrossel e estático: prospecção, descoberta, demonstração, negociação, objeções, acompanhamento e continuidade. A classificação de público, etapa, objetivo e métrica está em cada peça. Um Reel também pode qualificar; um post estático também pode ensinar.

Os 55 Reels mostram comportamento e mudança; os 55 carrosséis organizam raciocínio e oferecem material consultável; os 55 posts fixam uma ideia ou tarefa visual. Repetir um tema entre formatos é intencional se cada um acrescentar utilidade. Evitar publicar a mesma mensagem três vezes seguidas ou apenas transformar legenda em páginas.

Cadência completa independente de 28 semanas, com três peças na última: segunda e quinta Reel, terça e sexta carrossel, quarta e sábado estático; domingo reservado a respostas e leitura. A publicação de 6 peças por semana é uma hipótese de capacidade, não uma regra do algoritmo. O calendário combinado oferece alternativa de 55 semanas com um único perfil e 6 publicações totais por semana. O sprint exclusivo para vendedores usa os IDs 31–55 em 13 semanas independentes (três peças na última) ou 25 semanas compartilhadas com equipes comerciais; ele é uma alternativa ao ciclo completo.

Horários iniciais de teste: 12h30 e 19h30 em GMT-3. Alternar grupos comparáveis por duas semanas, registrar exposição e ajustar pelos dados da conta; não anunciar “melhor horário universal”. Stories e collabs seguem o manual operacional.

## 7. Penetração por profissão

Cada profissão merece um pequeno percurso, não somente um figurino. Exemplo para líderes: Reel de pedido ambíguo → carrossel de estrutura de alinhamento → post de pergunta de confirmação → DM com situação → convite ao piloto. Para professores: instrução longa → objetivo verificável → exemplo de fechamento → exercício de 30 segundos. Para advogados: excesso de termos → explicação com condição → conclusão com próximo passo. Para saúde: explicação fictícia → checagem de entendimento → escuta; sem prescrição, pacientes ou promessa clínica.

Para vendedores: cena de uma etapa comercial → exercício com frase e pergunta → cartão de preparação → TREINO com contexto VENDA → prática individual compatível. Segmentar SDR/BDR, executivo de contas, especialista técnico, varejo/serviços, representantes e renovação. A mensagem de entrada é “Prepare a próxima conversa comercial”. O vendedor pode ser usuário pagante, influenciador ou participante de programa empresarial; identificar quem pretende contratar antes de encaminhar a oferta. Materiais e respostas prontos estão na [campanha comercial](EXTENSAO_COMERCIAL.md).

Parcerias editoriais potenciais: professores de oratória, comunidades profissionais, especialistas em carreira e associações. Selecionar por qualidade da audiência e capacidade de exemplificar, não apenas seguidores. Antes de contratar creator, pedir composição do público, alcance recente comparável, direitos de uso e exemplos de comunicação responsável. Não há contratação ou contato realizado nesta entrega.

Brief de collab: duas pessoas encenam uma conversa de trabalho, revisam uma frase e convidam o público a experimentar. O especialista valida o contexto; o Matraca explica o exercício. Não exigir elogio ao produto nem usar o parceiro como “usuário comprovado” se ele só participou de uma gravação.

## 8. Mídia paga e orçamento

As cifras são envelopes gerenciais propostos, não estimativas de preço de mercado, autorização de gasto ou previsão de retorno. Custos de equipe e produção são separados da mídia. Antes de produção comercial, anunciar conteúdo educativo e interesse em piloto; nenhuma campanha deve induzir compra indisponível.

| Cenário mensal | Mídia | Produção e operação | Emprego |
| --- | --- | --- | --- |
| Descoberta orgânica | R$ 0 | Horas internas registradas | Validar mensagem e preparar atendimento |
| Teste enxuto | R$ 3.000 | Orçar à parte; usar gravação em lote | Duas situações profissionais, poucos criativos e revisão semanal |
| Expansão condicionada | R$ 8.000 | Orçar edição, atendimento e design adicionais | Somente após qualidade do lead, capacidade e custo sustentável observados |

No cenário de R$ 3.000, reservar inicialmente R$ 1.800 para descoberta, R$ 600 para aprofundar mensagens de melhor resposta e R$ 600 para experimentos. Se não houver audiência elegível para remarketing, usar a segunda parcela em prospecção; não inventar tamanho mínimo. Começar com quatro peças, duas situações e dois ganchos, sem pulverizar em dez profissões. A segmentação disponível precisa ser conferida na conta; não presumir que todas as profissões podem ser selecionadas como interesse.

Comparar mensagem geral sobre clareza com cenário específico. Mudar um fator principal por teste. Uma peça orgânica de alto alcance só vira candidata à mídia se também atrair o contexto de uso pretendido. Campanha de alcance mede distribuição; campanha de mensagens mede abertura de conversa; nenhuma das duas sozinha comprova vendas.

## 9. Medição e decisões

**Métrica principal antes da venda:** interessados qualificados que completam a primeira atividade combinada no piloto, quando este estiver disponível. Antes disso, usar conversas qualificadas e interesse consentido como indicadores intermediários. Separar quem apenas pediu um material de quem tem intenção de experimentar.

| Indicador | Definição | Decisão que ajuda a tomar |
| --- | --- | --- |
| Salvamentos por alcance | Salvamentos ÷ contas alcançadas na mesma janela | Utilidade consultável; comparar mesmo formato |
| Compartilhamentos por alcance | Compartilhamentos ÷ alcance | Relevância para outra pessoa |
| Conversas iniciadas | Pessoas únicas que iniciam conversa por peça | Clareza do próximo passo |
| Qualificação | Pessoas que declaram situação, interesse e viabilidade de participação ÷ conversas | Ajuste entre mensagem e público |
| Ativação no piloto | Participantes que realizam tarefa definida ÷ convidados com acesso | Fricção entre promessa e experiência |
| Retorno combinado | Participantes que retornam na janela acordada ÷ ativados elegíveis | Utilidade de continuidade, sem inferir causalidade |
| Custo por interessado qualificado | Mídia atribuída ÷ interessados qualificados | Sustentabilidade da aquisição intermediária |
| CAC, após venda | Custos de aquisição definidos ÷ novos clientes pagantes | Economia do negócio; declarar se inclui produção e equipe |

Exemplo aritmético, não projeção: R$ 3.000 de mídia e 60 interessados qualificados implicam R$ 50 por interessado. Se apenas 6 comprarem, o CAC de mídia será R$ 500; suporte, produção e equipe ainda ficam fora dessa conta. A viabilidade depende da margem real do cliente, não do tamanho da lista.

Primeira quinzena: estabelecer baseline própria e revisar a qualidade de todas as conversas, se o volume permitir. A cada duas semanas: manter conteúdo que gera situações pertinentes, revisar ganchos com abandono e descontinuar promessas que atraem demanda fora do escopo. Não declarar um “vencedor estatístico” a partir de poucos cliques. Amostra pequena orienta novas hipóteses.

## 10. Conversão, atendimento e pós-compra

Resposta inicial a TREINO: “Vamos começar pela sua próxima fala. Ela é para uma reunião, aula, apresentação ou outra situação? Enquanto isso, use este roteiro: público, mensagem, exemplo e próximo passo.”

Após resposta: “Para esse cenário, escolha uma mensagem que caiba em até 30 segundos e faça uma tentativa no seu aparelho. Qual parte você mais quer trabalhar: organizar, explicar ou concluir?”

Convite ao interesse: “O Matraca está em fase de piloto. Posso registrar seu interesse e avisar quando houver uma etapa compatível com esse objetivo? O material demonstrativo desta campanha usa avaliações simuladas; uma sessão real dependerá do ambiente e do escopo combinados.” Se a pessoa disser não, encerrar sem sequência insistente.

Pergunta sobre preço: “Os valores comerciais ainda estão em definição. A proposta é oferecer cursos e créditos de avaliação, com condições claras antes de qualquer contratação. Posso anotar o que você precisaria para decidir?” Não inventar cupom, urgência ou lote.

Após liberação, substituir o último convite pelo link verificado da oferta, explicitando conteúdo, créditos, acompanhamento e valor. Manter alternativa de tirar dúvida. O onboarding comercial deve conduzir a uma primeira tarefa compatível com o saldo, mostrar o consumo antes do envio, explicar relatório e limitações e indicar como buscar suporte.

Retenção: lembrete escolhido pela pessoa, retomada de uma prioridade, comparação de tarefas equivalentes e celebração de comportamento observado. Depoimentos só após experiência real, autorização e identificação do contexto; não transformar feedback de um piloto simulado em prova de eficácia da IA.

## 11. Critérios para revisar o plano

Revisar mensalmente público prioritário, motivos de interesse, objeções, custo de atendimento e disponibilidade real do produto. Abrir uma profissão nova quando houver conteúdo contextual confiável e capacidade de suporte. Expandir investimento somente quando o custo por cliente e a margem real puderem ser avaliados, ou quando houver orçamento explícito de pesquisa com teto de perda.

Fontes internas: [ensino](https://github.com/olimposlabs/matraca/blob/2a7b728/docs/PLANO_DE_ENSINO.md), [créditos e cobrança](https://github.com/olimposlabs/matraca/blob/2a7b728/docs/CREDITOS_E_COBRANCA.md), [execução do piloto](https://github.com/olimposlabs/matraca/blob/2a7b728/docs/EXECUCAO_SPI.md), [avaliações e modos de provedor](https://github.com/olimposlabs/matraca/blob/2a7b728/docs/technical/EVALUATIONS.md), [integração real](https://github.com/olimposlabs/matraca/blob/2a7b728/docs/technical/OPENAI.md). Contexto externo e limites de comparação: [baseline de mercado](BASELINE_MERCADO.md). Produção, respostas, distribuição e calendários: [operação](OPERACAO_E_MEDICAO.md).
