# Jornada e progresso

O perfil do aluno registra profissão, experiência, objetivos e entrada pela base ou pelo diagnóstico. O diagnóstico usa a fila e a rubrica simuladas. As prioridades partem dos menores níveis observáveis. Em cursos adaptativos, a sugestão de unidade usa títulos pertinentes e pré-requisitos satisfeitos. Uma organização com sequência obrigatória mantém a ordem publicada.

- `GET /api/journey` retorna perfil, diagnóstico, prioridades e cursos atribuídos.
- `PUT /api/journey/profile` salva os dados educacionais da própria pessoa.
- `GET /api/journey/courses/:enrollmentId` retorna progresso, bloqueios e avaliações vinculadas à versão.
- `PUT /api/journey/courses/:enrollmentId/study` recebe `unitId`, índices marcados e `completeStudy`.
- `GET /api/journey/evolution` retorna tentativas e resultados por critério. Comparações usam a mesma versão de rubrica. Professores e gestores podem indicar aluno no escopo atual.

Estudo e conclusão têm eventos distintos. O estudo validado concede créditos uma vez, antes da avaliação, quando o curso usa recompensa por progresso. Atividades sem avaliação obrigatória terminam ao concluir o estudo. Nas demais, o resultado válido completa a atividade junto ao débito. Falha ou cancelamento conserva o estudo e libera a reserva. A conclusão integral concede a recompensa configurada uma única vez.

Os eventos de aula, revisão e curso registram grupos vigentes, incluindo ancestrais ativos, no momento da conclusão. A transferência não reatribui os eventos anteriores. A migração 009 mantém progresso e versão ligados à matrícula e ao mesmo aluno.
