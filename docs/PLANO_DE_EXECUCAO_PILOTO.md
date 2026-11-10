# Plano de execução do piloto Matraca

Proposta de 10 de novembro de 2026, aguardando aprovação do fundador. Este documento define o trabalho a executar. Não declara funcionalidades implementadas, testes aprovados ou publicação realizada.

## Resultado esperado

Entregar o piloto completo e executável localmente, com portal público, área do aluno, administração white label e backoffice Matraca. Cadastros, autenticação, arquivos, cursos, progresso, avaliações, créditos, compras e faturas terão persistência e regras de negócio reais. Os serviços externos serão substituídos por adaptadores de simulação identificados.

O fundador fará seus testes somente após a implementação, os testes automatizados, a inspeção das telas e a correção das falhas encontradas. A aprovação deste plano autoriza executar todas as fases sem aprovações intermediárias de decisões rotineiras. Mudanças que alterem materialmente o escopo aprovado ou operações externas não abrangidas por ele serão explicitadas.

Fontes de requisitos são o [plano de ensino](PLANO_DE_ENSINO.md), as regras de [créditos e cobrança](CREDITOS_E_COBRANCA.md) e as decisões do fundador. Os padrões abaixo preenchem pendências para permitir execução autônoma. Tornam-se decisões do piloto após a aprovação deste plano.

## Fronteira entre aplicação e simulação

| Área | Funcionará no piloto | Fronteira externa simulada |
| --- | --- | --- |
| Identidade | Contas independentes por organização, convites, login, sessão e revogação | Entrega de e-mail em caixa local |
| Mídia | Câmera, microfone, upload, validação de duração, armazenamento privado e reprodução | Nenhuma simulação do armazenamento e da duração |
| Avaliação | Pedido, contexto, fila, estados, histórico, relatório e consumo | IA e transcrição com respostas sintéticas determinísticas |
| Comércio | Catálogo, pedido, pagamento registrado, concessão, extrato e recibo de demonstração | Processador de pagamento e seus eventos |
| Faturamento | Contrato, faixas, fechamento, fatura, ajustes e conciliação | Liquidação externa. Documento do piloto não será nota fiscal |
| White label | Cadastro de parceiro, roteamento local, branding e isolamento | DNS público e provisionamento em nuvem |
| Operação | Logs, métricas de uso, auditoria, falhas e recuperação | Custo de IA estimado, explicitamente identificado |

Respostas simuladas não serão apresentadas como análise real da fala. Transcrições sintéticas terão indicação visível. Critérios visuais ficarão sem observação quando a entrada for apenas áudio. A plateia será uma ambientação estática ou gravada. Interação ao vivo com personagens de IA permanece na evolução futura já discutida.

O término deste plano é um piloto local pronto para uso. A publicação em `matraca.ia.br`, o envio real de e-mails e a cobrança ou IA reais permanecem integrações posteriores. A aplicação não dependerá dessas credenciais para iniciar ou completar suas jornadas.

## Decisões propostas para executar sem novas rodadas de descoberta

| Tema | Padrão proposto para o piloto |
| --- | --- |
| Idioma e demonstração | Português brasileiro e pessoas fictícias, com seis alunos diretos, seis alunos do parceiro, uma escola e três professores, além dos gestores |
| Login | Link de acesso por e-mail, de uso único e com expiração. A entrega irá para caixa local de desenvolvimento. Cada organização terá identidade e sessão próprias |
| Organização e escola | Administrador da organização cria escolas e publica currículos. Gestor da escola administra alunos, professores, turmas e atribuições da própria escola |
| Professores | Escola pode convidar ou cadastrar professor pendente. Organização aprova sua atuação e registra certificação, conforme política configurável |
| Múltiplas turmas | Um aluno por organização, com vínculos independentes para turmas atuais e encerradas. Carteira e cobrança não se multiplicam por turma |
| Transferência | Entre escolas da mesma organização, preservando carteira e histórico. A origem perde acesso individual corrente, o destino recebe acesso pelo novo vínculo e a auditoria conserva a movimentação |
| Cursos | Curso base autoral completo do Matraca. Parceiro pode copiá-lo e editar sua própria versão ou criar curso do zero |
| Percurso | Começar pela base ou fazer diagnóstico. Organização pode impor sequência completa, sem saltos |
| Créditos iniciais | Um crédito por aluno e organização para diagnóstico de até 30 segundos, concedido uma única vez |
| Recompensas do curso | Demonstração com um crédito por aula, cinco por módulo e vinte ao concluir o curso. Valores e condições editáveis |
| Momento da recompensa | Marco de estudo libera o saldo antes da avaliação correspondente. Conclusão pedagógica da avaliação é um evento separado, evitando bloqueio circular |
| Repetição | Reabrir aula, repetir evento ou publicar nova versão não repete prêmio automaticamente. Uma nova matrícula com recompensa depende de regra explícita |
| Consumo | Áudio e vídeo usam um crédito por minuto ou fração, por pedido. Duração verificada no servidor, sem confiar no número enviado pelo navegador |
| Falha de avaliação | Reserva antes de processar, consumo após resultado válido persistido e liberação em falha definitiva ou cancelamento antes da conclusão |
| Reprocessamento | Retry técnico mantém pedido e cobrança únicos. Nova avaliação pedida pelo aluno consome novamente. Comentário humano não consome crédito de IA |
| Saldo | Sem expiração no piloto, uso das origens mais antigas primeiro e ausência de transferência entre organizações |
| Extras white label | Organização pode atribuir extras e delegar essa operação à escola. Consumo entra na fatura central da organização, sem cobrança antecipada duplicada |
| Autonomia da escola | Desabilitada inicialmente, habilitável por organização e escola, com limite de concessão e auditoria |
| Compra do aluno white label | Extras solicitados ao gestor no piloto. Checkout próprio do aluno fica disponível para os clientes diretos do Matraca |
| Faixas | Suportar preço por volume e progressivo. Catálogo direto considera quantidade comprada. Contrato white label considera consumo mensal agregado da organização |
| Preços de demonstração | Licenças de R$ 1.000 por organização, R$ 100 por escola e R$ 1 por aluno. Tabela inicial de consumo com faixa única de R$ 0,90. Todos editáveis e ilustrativos |
| Contagem de licenças | Escolas ativas e alunos ativos com convite aceito no corte, uma vez por organização. Professor sem papel de aluno não entra nessa contagem |
| Competência e corte | Fuso America/Sao_Paulo. Fechar mês encerrado e cobrar licenças do mês seguinte. Snapshot no encerramento, sem proporcionalidade no piloto |
| Mudanças contratuais | Vigência por competência mensal, com preços históricos preservados. Correção de fatura fechada gera ajuste rastreável |
| Rankings | Pontos anuais dentro da organização e de seus grupos, sem mistura entre parceiros. Prêmios configuráveis por período e classificação |
| XP e empates | Proposta inicial de 20 pontos por aula concluída, 100 por revisão de módulo e 500 por curso. Uma concessão por marco. Desempate pelo instante em que alcançou os pontos, seguido de identificador estável |
| Premiação | Exemplo de 3, 2 e 1 créditos para os três primeiros, concedidos uma única vez por fechamento. Créditos não aumentam os pontos do ranking |
| Git | Propor `main` como integração, preservar os documentos existentes e trabalhar em branches `codex/`. Registrar commits e abrir PR quando o acesso remoto permitir |

A contagem financeira será independente de atividade recente. Um aluno ativo aceito conta mesmo sem enviar vídeos naquele mês. Entradas depois do corte passam a integrar o próximo snapshot. Um usuário com vários papéis que também seja aluno elegível conta uma vez.

## Arquitetura proposta

Aplicação TypeScript com React Router 8, React, Cloudflare Workers e plugin Vite, banco D1 com migrações SQL/Drizzle, objetos privados em R2 e processamento por Queues. A escolha busca execução serverless e desenvolvimento local com os mesmos contratos de serviços. As versões compatíveis serão verificadas e fixadas no bootstrap. A documentação atual oferece [integração React Router](https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/) e [bindings locais](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).

O desenvolvimento usará emulação local persistente, sem bindings remotos. O [plugin Vite](https://developers.cloudflare.com/workers/vite-plugin/reference/api/) permite configurar persistência. Um Worker reunirá entrada web, consumidor de fila e eventos agendados. A divisão interna separará domínio, persistência, provedores e interface. Não será necessário criar um conjunto de microsserviços para o piloto.

As identidades terão unicidade por organização e e-mail normalizado. O host será resolvido por cadastro permitido. Tokens de acesso e sessões terão vínculo com organização, finalidade e expiração. Tokens serão aleatórios, armazenados como hash e consumidos atomicamente. Cookies serão host-only, HttpOnly, SameSite e Secure em HTTPS. Toda operação verificará escopo no servidor. O transporte de e-mail poderá ser trocado depois sem mudar a identidade do usuário.

Carteira, reservas, concessões, pedidos, eventos de pagamento, resultados e fechamento usarão operações atômicas, restrições e chaves de idempotência. O banco guardará jobs e outbox recuperáveis. A [fila admite entrega repetida](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), portanto o consumidor não poderá presumir execução única.

Arquivos serão enviados e lidos por streaming ou partes. O parser de mídia proposto é o pacote base Mediabunny, com leitura por faixas do armazenamento e duração calculada a partir das trilhas. A compatibilidade será demonstrada na primeira fase, antes de construir o pipeline. Não presumir compatibilidade de extensões FFmpeg nativas com Workers. Referências são [leitura de mídia](https://mediabunny.dev/guide/reading-media-files), [R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) e [limites do runtime](https://developers.cloudflare.com/workers/platform/limits/).

Testes usarão Vitest, a [integração oficial para Workers](https://developers.cloudflare.com/workers/testing/vitest-integration/) e Playwright. Agendamentos terão o mesmo handler em produção e em simulação local com relógio controlado. [Cron local](https://developers.cloudflare.com/workers/configuration/cron-triggers/) exige invocação explícita, portanto o teste não dependerá de esperar a virada do mês.

Serverless reduz infraestrutura ociosa, mas não garante custo fixo produtivo zero. O custo externo será validado posteriormente com medições e condições do provedor. O piloto local não consumirá APIs pagas. A decisão de hospedagem produtiva deverá considerar [preços do runtime](https://developers.cloudflare.com/workers/platform/pricing/), mídia e avaliações reais.

## Modo de execução

Todas as fases começam pendentes. Cada fase terá implementação, validação dos critérios, correção das falhas e atualização documental. Uma fase dependente só será considerada concluída depois de passar pelos requisitos anteriores.

Trabalhos independentes poderão ocorrer em paralelo, com contratos e responsabilidade por arquivos definidos. Créditos e autorização terão revisão específica antes de sua integração às telas. A execução manterá um registro curto com fase, passo, resultado dos testes, problemas resolvidos e próximos itens. Retomadas usarão esse registro, sem presumir conclusão pela passagem do tempo.

Comandos previstos são `npm run dev`, `npm run db:migrate`, `npm run db:seed`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` e `npm run build`. Eles ainda não existem. Serão criados, executados e documentados na fase 01. Reset da demonstração terá escopo local explícito e preservará qualquer estado externo.

## Fase 01 — Fundação e prova técnica

**Dependência** aprovação deste plano.

1. Conferir Git, preservar documentos existentes e registrar o estado inicial. Estabelecer a branch de integração aprovada e a branch de trabalho.
2. Criar projeto, manifesto, lockfile, versão de runtime suportada, lint, tipos, testes, build e configuração local. Evitar leitura de arquivos de credenciais existentes.
3. Preparar Worker, D1, R2 e Queue locais, migrações e estado persistente. Desabilitar chamadas e bindings remotos.
4. Provar roteamento por hosts locais para Matraca, parceiro e backoffice. Usar nomes sob `.localhost` ou resolução local controlada pelo processo de desenvolvimento.
5. Provar gravação e interpretação de MP4, WebM e áudio, incluindo WebM de MediaRecorder sem campo de duração. Validar duração de cinco minutos, arquivos truncados e timestamps deslocados. Resolver incompatibilidades do parser antes de avançar.
6. Demonstrar armazenamento, recuperação de arquivo e dados após reinício. Criar base dos scripts de seed e restauração local.
7. Configurar validação contínua de tipos, lint, testes e build no repositório. Disponibilidade de runner remoto não bloqueará a verificação local.

**Aceite** app inicia com um comando, hosts resolvem, dados persistem, parser mede os formatos necessários e build passa. Documentar os resultados reais das provas.

## Fase 02 — Organizações, identidade e autorização

**Dependência** fase 01.

1. Criar organizações, domínios, identidades, convites, sessões, vínculos e eventos de auditoria.
2. Implementar login por link de acesso, expiração, uso único, logout e revogação, com caixa de e-mail restrita ao ambiente local.
3. Separar acesso ao backoffice do acesso a organizações. Aplicar os papéis de aluno, professor, gestor escolar, administrador da organização e operador Matraca.
4. Centralizar autorização por organização, escola, atribuição de professor e propriedade do recurso. Validar também downloads, exportações e endpoints.
5. Impedir host desconhecido, troca de organização por parâmetros manipulados e uso de sessão ou token em outro host. Proteger mutações contra origem indevida.
6. Testar o mesmo e-mail em Matraca e parceiro, e em uma terceira organização de teste. Suspensão de usuário ou vínculo deverá surtir efeito imediatamente.

**Aceite** contas e sessões independentes, login e revogação funcionais, matriz de acesso positivo e negativo aprovada no servidor.

## Fase 03 — Portais e branding

**Dependência** fase 02.

1. Implementar página pública, apresentação do produto, catálogo, preços de demonstração e entradas de cadastro/login.
2. Criar layouts navegáveis para aluno, professor, escola, organização e backoffice, com componentes e estados de carregamento, vazio e erro.
3. Implementar cadastro de parceiro no backoffice, subdomínio local, situação, administrador e acesso ao painel da organização.
4. Implementar branding com nome, logo, cores, fontes e layouts predefinidos, textos configuráveis e nome singular/plural do crédito.
5. Criar edição com preview imediato, publicação e restauração da configuração anterior. Garantir contraste legível e isolamento entre parceiros.
6. Adaptar navegação e formulários a desktop e celular, incluindo teclado, foco e rótulos acessíveis.

**Aceite** portais navegáveis com identidade distinta. Alteração de marca persiste após recarga e afeta somente a organização correta. Ações de fases futuras entram no aceite final apenas quando conectadas ao seu fluxo real.

## Fase 04 — Gestão escolar e hierarquia

**Dependência** fases 02 e 03.

1. Implementar escolas, gestores, professores, alunos, turmas, status e convites pelas telas.
2. Implementar cadastro e aprovação de professores, certificações e atribuição a escolas e turmas.
3. Permitir aluno em várias turmas, encerramento de turma e consulta ao histórico dos vínculos.
4. Implementar tipos e grupos configuráveis, como estado, cidade, escola e turma, com hierarquia válida e associação dos participantes.
5. Implementar transferência entre escolas da mesma organização, encerrando vínculos incompatíveis e atualizando autorização e grupos.
6. Oferecer pesquisa, filtros, paginação, edição e arquivamento, preservando registros históricos necessários.

**Aceite** administrador e escola completam os cadastros e vínculos pela interface. Transferência preserva o aluno, a carteira e o histórico, com mudança correta dos acessos.

## Fase 05 — Carteira e regras de crédito

**Dependência** fases 02 e 04.

1. Criar ledger de movimentações, origens, reservas, ajustes e chaves de evento. Definir saldo disponível como saldo líquido menos reservas ativas.
2. Implementar concessão manual, saldo inicial, pacotes administrativos e permissões de extras para escolas.
3. Implementar reserva, confirmação de consumo, liberação e estorno rastreável. Nenhuma correção apagará movimentação anterior.
4. Implementar cálculo por duração verificada, separado do limite de cada atividade. Frações positivas além do minuto entram no próximo crédito.
5. Implementar extrato do aluno e visões administrativas por origem, responsável, período e organização.
6. Testar concorrência real no domínio, saldo insuficiente, eventos duplicados, ajustes e recuperação após falha.

**Aceite** saldo não fica negativo, efeitos repetidos são únicos e extratos reconciliam com reservas e lançamentos. Com um crédito e dois pedidos simultâneos de um crédito, apenas um poderá reservar.

## Fase 06 — Editor de cursos e conteúdo completo

**Dependência** fases 03, 04 e 05.

1. Modelar curso, módulo, capítulo, aula, revisão, atividade, critérios, pesos, recompensas e pré-requisitos.
2. Criar editor com ordenação, textos, referências, checklists, anexos, slides e mídia. Suportar unidade com conteúdo e unidade somente para acompanhamento ou avaliação.
3. Implementar rascunho, validação, preview, publicação e versionamento. Matrículas e avaliações guardarão a versão aplicada.
4. Importar integralmente o plano autoral existente, com 12 módulos, 36 aulas e 12 revisões, incluindo os exercícios e referências.
5. Permitir copiar a base Matraca, personalizar a cópia e criar curso independente. Publicação na base não sobrescreverá cursos dos parceiros.
6. Configurar concessão de créditos na aquisição ou por progresso, critérios de conclusão e sequência obrigatória ou adaptada.
7. Atribuir cursos publicados a turmas ou alunos e definir a disponibilidade no catálogo direto.

**Aceite** todo o curso está navegável e editável conforme permissão. É possível publicar curso próprio e atividade de acompanhamento. Nova versão preserva interpretação do histórico antigo.

## Fase 07 — Captura, upload e ambientação

**Dependência** fases 01, 05 e 06.

1. Implementar gravação de áudio/vídeo, escolha de dispositivo quando suportada, cronômetro, preview, descarte e regravação.
2. Implementar seleção de arquivo e upload com progresso, cancelamento, validação de formato e tamanho e tratamento de interrupção.
3. Persistir arquivos privados, metadados verificados e associação com organização, aluno e atividade. Rejeitar mídia inválida antes de reservar créditos.
4. Implementar player com busca temporal e leitura por faixas autorizada. Evitar carregar vídeo inteiro na memória do Worker.
5. Oferecer cenários de conversa individual, reunião executiva e plateia grande, com ambientação visual e descrição do desafio durante a gravação.
6. Configurar atividades curtas de 30 segundos e revisões de até cinco minutos. Exibir limite e estimativa de créditos antes do envio.
7. Testar permissões recusadas, falta de câmera/microfone, arquivo truncado, áudio puro, captura real automatizada e reinício do ambiente.

**Aceite** upload e gravação geram arquivos reais reproduzíveis e durações confiáveis. A reprodução e o download obedecem ao mesmo escopo de acesso da avaliação.

## Fase 08 — Processamento e avaliação simulada

**Dependência** fases 05, 06 e 07.

1. Definir contrato do provedor com critérios, notas, justificativas, evidências temporais, recomendações e informações de uso.
2. Construir contexto com objetivo da atividade, versão da rubrica, perfil, metas e histórico pertinente do aluno naquela organização.
3. Criar estados de pedido, reserva, fila, processamento, sucesso, falha e cancelamento. Persistir job e outbox para recuperação.
4. Implementar mock determinístico com sucesso, demora, falha transitória, falha definitiva, timeout e resposta inválida, selecionáveis no modo de demonstração.
5. Validar respostas, manter timestamps dentro da duração e marcar ausência de critérios não observáveis em áudio.
6. Confirmar resultado e débito de forma consistente. Repetição de mensagem não poderá criar outro relatório ou consumo.
7. Implementar tentativas limitadas, retomada e liberação de reserva após falha definitiva. Exibir andamento e erro compreensível ao aluno.

**Aceite** o pipeline real conclui uma avaliação mockada, trata falhas e resiste a duplicações e reinício. Cada resposta sintética aparece identificada na interface.

## Fase 09 — Jornada do aluno e relatórios

**Dependência** fases 06 e 08.

1. Implementar onboarding com profissão, experiência, objetivos e apresentação inicial.
2. Oferecer início pela base ou diagnóstico. Transformar diagnóstico simulado em prioridades e trilha recomendada, respeitando imposições da organização.
3. Implementar estudo, checklists, liberação de crédito, envio de atividade e conclusão pedagógica sem concessões duplicadas.
4. Construir relatório detalhado com critérios e pesos, notas, pontos fortes, dificuldades, recomendações, plano de prática e origem da avaliação.
5. Integrar evidências ao player, comparação entre tentativas e evolução por dimensão. Mudanças de rubrica deverão ficar visíveis para evitar comparações enganosas.
6. Implementar histórico, metas, próximos passos e versão imprimível do relatório. Restringir exportação ao mesmo escopo do acesso normal.
7. Garantir que o aluno avulso possa concluir a jornada por autoavaliação e prática, sem professor obrigatório.

**Aceite** aluno entra, estuda, recebe saldo, grava, recebe feedback, identifica prioridades e avança, tanto no percurso obrigatório quanto no adaptado.

## Fase 10 — Professores, mentorias e plano individual

**Dependência** fases 04 e 09.

1. Implementar painel do professor com turmas, alunos atribuídos, avaliações e necessidades de acompanhamento.
2. Permitir revisão de trechos, observações por critério e apreciação humana identificada, preservando o relatório original da IA.
3. Registrar mentoria com data, professor, aluno, evidências, dificuldades, orientações, ações e prazo de acompanhamento.
4. Atualizar plano individual com tarefas, metas e estados de execução. Manter autor e histórico das alterações.
5. Exibir evolução e resposta do aluno às orientações nas visões do professor, aluno e gestores autorizados.
6. Testar perda de vínculo, professor suspenso, transferência e tentativa de acessar aluno não atribuído.

**Aceite** professor e aluno completam um ciclo de mentoria e nova prática, com autoria clara e histórico preservado.

## Fase 11 — Gamificação, rankings e prêmios

**Dependência** fases 05 e 09.

1. Implementar eventos únicos de XP, medalhas, marcos e visualização da jornada.
2. Configurar pontos e conquistas por organização, com condições de concessão explícitas.
3. Implementar ranking anual da organização e rankings por grupos, filtros, posição do aluno e desempates determinísticos.
4. Registrar atribuição de grupo no momento do evento. Transferências não moverão retroativamente pontos históricos de uma escola para outra.
5. Implementar campanhas de premiação com período, escopo, posições e créditos configuráveis.
6. Fechar ranking com snapshot, conceder créditos e registrar origem. Repetir fechamento não duplicará prêmio.

**Aceite** rankings não misturam organizações, reenvios não geram pontos ilimitados e premiações reconciliam com o extrato do aluno.

## Fase 12 — Compras, contratos e faturamento

**Dependência** fases 05, 06, 08 e 11.

1. Implementar catálogo de cursos e pacotes, pedido, checkout simulado e histórico de compras do cliente direto.
2. Simular pagamento aprovado, recusado, pendente e cancelado, incluindo eventos repetidos e fora de ordem. Conceder curso e créditos uma única vez após confirmação válida.
3. Implementar contrato white label com licenças, condições de extras, vigência e tabelas por volume ou progressivas, incluindo faixa única.
4. Validar intervalos de preço e calcular valores em centavos. Mostrar prévia antes de publicar tabela ou fechar cobrança.
5. Apurar consumo concluído por organização e competência. Distinguir concedido, reservado, consumido e estornado, independentemente da origem do crédito.
6. Fazer snapshot de escolas e alunos elegíveis, sem duplicar alunos por turma, papel ou transferência.
7. Emitir fatura com licença do mês seguinte e consumo do anterior. Preservar contrato aplicado, linhas, total, estados e ajustes.
8. Simular liquidação, repetir fechamento e conciliar faturas, pagamentos e consumo. Extras white label não gerarão cobrança na concessão e novamente no uso.

**Aceite** compra direta completa, faixas corretas e fechamento idempotente. Reproduzir o exemplo de R$ 1.440 documentado e distinguir preço por volume e progressivo nos limites.

## Fase 13 — Backoffice operacional e controles

**Dependência** fases 03 a 12.

1. Concluir administração de parceiros, domínios locais, curso base, catálogo direto, contratos, preços e concessões manuais.
2. Criar dashboards por organização, escola e aluno com minutos reais, créditos, saldo, pedidos, falhas, compras e faturamento.
3. Exibir custos simulados separadamente do consumo real, com parâmetros e fórmula de estimativa editáveis.
4. Implementar indicadores de abuso e limites configuráveis de frequência, simultaneidade, tamanho de arquivo e concessões administrativas.
5. Implementar consulta à auditoria, inspeção de jobs, reprocessamento técnico elegível e reconciliação de reservas.
6. Disponibilizar controles locais de cenário de IA, pagamento, e-mail e relógio, protegidos e ausentes da configuração produtiva.
7. Implementar fechamento local manual pela mesma função dos eventos agendados. Documentar recuperação de jobs e problemas comuns.

**Aceite** fundador provisiona um parceiro utilizável pelo backoffice, acompanha números reconciliados e exercita falhas sem editar código ou banco manualmente.

## Fase 14 — Integração final, correções e entrega

**Dependência** todas as fases anteriores.

1. Montar seed reproduzível com seis alunos diretos, uma organização parceira, uma escola, três professores e seis alunos vinculados, mais os administradores.
2. Incluir o mesmo e-mail em contextos diferentes e exemplos de progresso, mentoria, crédito, compra e faturamento. Fixtures adicionais de isolamento usarão banco de teste separado.
3. Executar todas as jornadas de aceite abaixo pela interface, com o banco e armazenamento reais do ambiente local.
4. Executar testes de autorização, concorrência, idempotência, preços, duração e recuperação. Corrigir falhas e repetir somente os testes pertinentes à alteração e aos riscos restantes.
5. Inspecionar desktop e celular, teclado, foco, contraste, erros e carregamento. Testar browsers automatizados suportados, registrando limitações de hardware real em vez de alegar testes não realizados.
6. Verificar build e instalação reproduzível. Reiniciar aplicação e comprovar persistência de mídia, contas, cursos, progresso, créditos, pedidos e faturas.
7. Atualizar README, arquitetura, operação, testes e limitações. Preparar guia com URLs, personas, caixa de e-mail local, comandos reais e roteiro de teste do fundador.
8. Revisar alterações, registrar commits e encaminhar PR quando houver acesso. Deixar o piloto local iniciado e verificar seus endereços antes da entrega.

**Aceite** nenhum fluxo obrigatório depende de tela fictícia ou manipulação manual do banco. Todos os testes necessários passam, o app está acessível e as integrações simuladas estão claramente identificadas.

## Jornadas finais obrigatórias

| ID | Jornada a executar antes da entrega |
| --- | --- |
| J01 | Visitante acessa portal, cria conta, compra curso com pagamento simulado, recebe créditos e inicia a jornada |
| J02 | Aluno estuda aula, recebe crédito, grava ou envia vídeo, acompanha processamento e consulta relatório |
| J03 | Aluno realiza revisão de até cinco minutos e navega pelos trechos indicados no player |
| J04 | Aluno envia áudio e recebe relatório com critérios visuais indisponíveis |
| J05 | Diagnóstico gera prioridades, enquanto outro aluno segue sequência obrigatória configurada pelo parceiro |
| J06 | Backoffice cria parceiro, subdomínio local, contrato e administrador. O administrador publica branding e copia curso base |
| J07 | Organização cria escola, aprova professor e delega gestor. Escola cria turmas e matricula aluno em mais de uma |
| J08 | Professor revisa evidência, registra mentoria, ajusta plano e acompanha nova tentativa |
| J09 | Administrador transfere aluno entre escolas, preservando histórico e alterando acessos |
| J10 | Mesmo e-mail usa dois hosts em abas diferentes, sem compartilhar sessão, vídeos, saldo ou progresso |
| J11 | Usuário tenta acessar recurso de outra organização ou escola e recebe negativa no servidor |
| J12 | Aluno compra pacote extra. Callback duplicado concede os créditos uma única vez |
| J13 | Escola autorizada concede extras. Escola sem autorização é bloqueada. Consumo compõe somente a fatura central |
| J14 | Dois pedidos concorrem pelo último crédito e somente um consegue reservar |
| J15 | Falha transitória, falha definitiva, timeout e reinício após reserva terminam em resultado único ou liberação consistente |
| J16 | Ranking concede prêmio de 3, 2 e 1 créditos e repetir fechamento não altera os saldos |
| J17 | Fechamento de novembro apresenta consumo de novembro e licenças de dezembro, com alunos contados uma vez |
| J18 | Alteração de preço e curso preserva contratos, rubricas e resultados históricos |
| J19 | Reinício mantém todos os dados e a reprodução dos arquivos. Reset atua apenas sobre o ambiente local selecionado |
| J20 | Aluno direto conclui o curso completo sem depender de professor ou serviço externo real |

## Casos de cálculo e integridade

- Durações de 30, 60, 61, 119, 120, 300 e 301 segundos devem consumir respectivamente 1, 1, 2, 2, 2, 5 e 6 créditos. Uma atividade limitada a 300 segundos rejeita 301 segundos mesmo com saldo suficiente.
- Testar fração positiva além de 60 segundos, múltiplas trilhas e timestamps iniciais deslocados. O parser deverá aplicar uma definição documentada de duração da apresentação.
- Faixas de teste de 1 a 9 créditos a R$ 1 e de 10 em diante a R$ 0,90 resultam em R$ 9 por dez créditos no modo por volume e R$ 9,90 no progressivo.
- Fatura de uma organização, três escolas, cinquenta alunos e cem créditos a R$ 0,90 deve reproduzir R$ 1.440 com as licenças ilustrativas.
- Uma concessão, compra, conclusão, avaliação ou premiação repetida tecnicamente mantém um único efeito. Resultado e consumo não podem divergir após retomada.
- O uso de transação ou batch deverá demonstrar o comportamento sob disputa. Uma atualização condicional que afeta zero linhas não poderá ser tratada automaticamente como reserva bem-sucedida.

## Recuperação e limites da entrega

Migrações serão versionadas. Antes de mudanças que afetem estado local existente, registrar checkpoint ou exportação recuperável. Rollback preferirá reversão de código e correção progressiva de dados, preservando ledger e auditoria. Reset destrutivo ficará restrito ao seed local selecionado.

Os contratos de domínio deverão permitir substituir os adaptadores externos sem reescrever carteira, cursos ou faturamento. O mock não comprova qualidade de feedback de um modelo real, custo por minuto de IA, entrega de e-mail, liquidação bancária nem funcionamento de DNS público. Essas validações serão registradas como pendências externas específicas.

O emulador de filas não reproduz todas as características de concorrência produtiva. Os testes concorrentes do domínio são obrigatórios e a integração em nuvem terá validação própria. Câmera em um celular físico depende do navegador, permissões e contexto seguro, portanto o guia distinguirá o que foi automatizado do que exige dispositivo real.

## Condição de conclusão

O plano termina quando as 14 fases e as 20 jornadas estão verificadas, os dados persistem após reinício, as regras financeiras e de isolamento passam nos testes e o fundador recebe um piloto navegável com guia de uso. Qualquer item obrigatório ainda falho mantém o trabalho em andamento.

O plano não depende de uma nova rodada de aprovação ao final de cada fase. A implementação começa após a aprovação desta proposta, incluindo seus padrões de execução. Publicação externa e ativação de serviços reais ficam fora dessa aprovação local.
