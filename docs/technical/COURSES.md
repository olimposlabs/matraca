# Cursos e conteúdo versionado

O parser importa integralmente o plano autoral:12 módulos,36 aulas,12 revisões e192 itens de checklist. O teste reconstrói a fonte byte a byte, preservando referências, ressalvas e apêndices. O modelo operacional define atividades de30 segundos e revisões de300 segundos; descritores seguem a escala da fonte. Pesos iniciais iguais são configuração de demonstração, sujeitos à calibração pedagógica.

## Estado

A migração 006 e o seed completo foram aplicados à demonstração. A revisão independente do backend e as regressões constam de [PHASE06_BACKEND_REVIEW.md](PHASE06_BACKEND_REVIEW.md).

## Contratos

- Administrador: GET/POST `/api/courses/manage`, GET/PUT `/:id`, POST `/:id/publish`, `/:id/archive`, `/:id/assign`, GET/POST `/:id/assets`, GET `/:id/assignable` com busca e paginação de alunos e turmas.
- Escola: GET `/api/courses/school`, GET `/:id`, GET `/:id/assignable` e POST `/:id/assign`. Apenas versões publicadas e alunos ou turmas das escolas ativas que a pessoa administra.
- Operador: os mesmos endpoints sob `/api/backoffice/courses/:orgId`.
- Base compartilhada: GET `/api/courses/base` lista versões autorizadas de cursos publicados da organização Matraca ativa. A criação usa `copyBaseCourseId` e confere `copyBaseVersionId` quando informado. O portal envia a versão selecionada. Uma troca concorrente devolve 409. A cópia cria objetos próprios para os anexos.
- Aluno: GET `/api/courses` e `/api/courses/:id`, com a versão registrada na matrícula. Desativar cursos impede acesso atual, preservando dados.
- Materiais: GET `/api/course-assets/:id`, autenticado e com suporte a uma faixa de bytes. Aluno só lê anexos citados em sua versão; anexos de rascunho ficam restritos ao editor.

Rascunho usa revisão otimista; salvar ou publicar um rascunho desatualizado retorna409. Publicações são snapshots imutáveis. Publicar novamente o mesmo documento retorna a versão existente e reativa um curso arquivado. Matrículas não migram silenciosamente quando outra versão é publicada. Atribuição à turma cria vínculos para alunos atuais; novas matrículas escolares recebem a versão de maior número já atribuída à turma. Cursos arquivados deixam de gerar novas matrículas, preservando acesso das matrículas existentes. Cancelar a matrícula do curso revoga leitura de conteúdo e anexos; concluir o curso preserva esse acesso.

Cursos suportam módulos, unidades, capítulos como agrupamento editorial, ordem por posição na lista, pré-requisitos, conteúdo ou acompanhamento, checklists, referências, anexos, rubricas, pesos e recompensas. Validação de publicação rejeita conteúdo obrigatório vazio, IDs duplicados, ciclos e critérios sem peso positivo. Dados de origem permanecem arquivados no documento do curso.

## Arquivos

Materiais ficam em filesystem privado. PDFs e slides em PDF têm limite20 MB e verificação de cabeçalho/trailer; isso não equivale a validação semântica de cada página. Imagens PNG/JPEG/WebP têm decodificação completa limitada a16 milhões de pixels e uma página, rejeitando arquivos que conservem cabeçalho válido mas pixels truncados. Áudio/vídeo usam o probe de pacotes existente, até200 MB e60 minutos. Não há execução de HTML enviado pelo usuário. Respostas têm CSP restritiva e nosniff. PDFs são oferecidos para download. Chaves de objetos não vêm do navegador.

## Validação e próximos gates

Os doze testes de API/modelo cobrem cópia, publicação repetida e após arquivo, versão preservada, atribuição de nova versão a ingressantes, edição concorrente, isolamento, curso de acompanhamento, toggle, seed aditivo, cancelamento de acesso e anexos privados/ranges/truncamento. Os seis testes do importador verificam integridade da fonte. A revisão do backend está registrada em `PHASE06_BACKEND_REVIEW.md`. A suíte integrada registrou 171 testes aprovados. Treze jornadas Playwright em schema isolado cobriram editor, aluno, backoffice e atribuição escolar em desktop e celular.

Rollback preserva versões, matrículas e objetos; reverte código e restringe acesso até reconciliar a migração. Não há deploy nesta fase.

A migração 016 libera a primeira versão do currículo autoral identificado no seed. Publicações futuras e os demais cursos começam privados para cópia. No backoffice, o operador pode selecionar uma versão publicada, trocar a seleção ou manter o curso privado em **Publicação → Modelo para parceiros**. A atualização compara a seleção anterior e registra o operador. Cópias e matrículas já criadas preservam seus dados. Se for preciso pausar novas cópias, retire a seleção no backoffice e preserve os objetos existentes.
