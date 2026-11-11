# Avaliação simulada e fila

A avaliação usa uma gravação privada validada pelo servidor. A API considera a duração em microssegundos, a modalidade observada, o objetivo e a versão matriculada. O simulador recebe rubrica, perfil educacional e até cinco resultados recentes do mesmo aluno e organização. Notas e trechos são ilustrações determinísticas. O custo atribuído ao provedor simulado é zero.

- `POST /api/evaluations` recebe `recordingId`, `clientKey` e `scenario`. Retorna HTTP 202 com identificador, estado e créditos.
- `GET /api/evaluations` lista o histórico paginado. Professores e gestores podem selecionar aluno autorizado.
- `GET /api/evaluations/:id` retorna estado, rubrica, relatório e informações para localizar trechos na gravação.
- `POST /api/evaluations/:id/cancel` cancela um pedido ativo do próprio aluno.

Pedido, reserva, job e evento de outbox entram juntos na mesma transação. A chave por aluno e organização protege retries, inclusive após uma resposta perdida. Gravações com avaliação ativa não iniciam outra avaliação simultânea. Cada aluno pode manter até três pedidos em andamento.

O processo local busca tarefas com `FOR UPDATE SKIP LOCKED`. Cada tentativa obtém lease de 30 segundos com token distinto. Depois de vencer, outro processo pode recuperar o trabalho. O provedor tem prazo de oito segundos. Falhas temporárias e timeouts têm até três tentativas, com espera crescente. Uma resposta atrasada de outro lease não pode concluir o pedido.

O servidor rejeita resposta incompleta, critério duplicado, duração divergente, evidência fora da gravação e nota em critério incompatível com o formato. As notas são ponderadas no servidor. Resultado, débito, estado final e outbox são confirmados na mesma transação. Falha final ou cancelamento libera a reserva. Se a persistência falhar, o débito reverte e o lease pode ser recuperado.

Testes com PostgreSQL isolado cobrem concorrência, replay, saldo insuficiente, escopo, falha definitiva, payload inválido, timeout, cancelamento durante processamento e recuperação após falha de persistência. Cenários de simulação ficam disponíveis no portal local. Nenhuma chave de IA externa é necessária.
