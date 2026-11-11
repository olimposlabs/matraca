# Cursos e conteúdo versionado — implementação parcial F06

O parser importa integralmente o plano autoral:12 módulos,36 aulas,12 revisões e192 itens de checklist. O teste reconstrói a fonte byte a byte, preservando referências, ressalvas e apêndices. O modelo operacional define atividades de30 segundos e revisões de300 segundos; descritores seguem a escala da fonte. Pesos iniciais iguais são configuração de demonstração, sujeitos à calibração pedagógica.

## Estado

Backend, importação e seed estão implementados neste checkout; a fase não está concluída. Editor visual, navegação do aluno, integração final com F05, revisão independente e gates remotos permanecem pendentes. A migração006 ainda não foi aplicada à demonstração.

## Contratos

- Administrador: GET/POST `/api/courses/manage`, GET/PUT `/:id`, POST `/:id/publish`, `/:id/archive`, `/:id/assign`, POST `/:id/assets`.
- Operador: os mesmos endpoints sob `/api/backoffice/courses/:orgId`.
- Base publicada: GET `/api/courses/base`; cópia usa `copyBaseCourseId` na criação e cria objetos próprios para os anexos.
- Aluno: GET `/api/courses` e `/api/courses/:id`, com a versão registrada na matrícula. Desativar cursos impede acesso atual, preservando dados.
- Materiais: GET `/api/course-assets/:id`, autenticado e com suporte a uma faixa de bytes. Aluno só lê anexos citados em sua versão; anexos de rascunho ficam restritos ao editor.

Rascunho usa revisão otimista; salvar ou publicar um rascunho desatualizado retorna409. Publicações são snapshots imutáveis. Publicar novamente o mesmo documento retorna a versão existente e reativa um curso arquivado. Matrículas não migram silenciosamente quando outra versão é publicada. Atribuição à turma cria vínculos para alunos atuais; novas matrículas escolares recebem a versão de maior número já atribuída à turma. Cursos arquivados deixam de gerar novas matrículas, preservando acesso das matrículas existentes. Cancelar a matrícula do curso revoga leitura de conteúdo e anexos; concluir o curso preserva esse acesso.

Cursos suportam módulos, unidades, capítulos como agrupamento editorial, ordem por posição na lista, pré-requisitos, conteúdo ou acompanhamento, checklists, referências, anexos, rubricas, pesos e recompensas. Validação de publicação rejeita conteúdo obrigatório vazio, IDs duplicados, ciclos e critérios sem peso positivo. Dados de origem permanecem arquivados no documento do curso.

## Arquivos

Materiais ficam em filesystem privado. PDFs e slides em PDF têm limite20 MB e verificação de cabeçalho/trailer; isso não equivale a validação semântica de cada página. Imagens PNG/JPEG/WebP têm decodificação completa limitada a16 milhões de pixels e uma página, rejeitando arquivos que conservem cabeçalho válido mas pixels truncados. Áudio/vídeo usam o probe de pacotes existente, até200 MB e60 minutos. Não há execução de HTML enviado pelo usuário. Respostas têm CSP restritiva e nosniff. Chaves de objetos não vêm do navegador.

## Validação e próximos gates

Os doze testes de API/modelo cobrem cópia, publicação repetida e após arquivo, versão preservada, atribuição de nova versão a ingressantes, edição concorrente, isolamento, curso de acompanhamento, toggle, seed aditivo, cancelamento de acesso e anexos privados/ranges/truncamento. Os seis testes do importador verificam integridade da fonte. A revisão do backend está registrada em `PHASE06_BACKEND_REVIEW.md`. A suíte completa e o E2E do editor devem ser executados após a integração de frontend e da F05.

Rollback preserva versões, matrículas e objetos; reverte código e restringe acesso até reconciliar a migração. Não há deploy nesta fase.
