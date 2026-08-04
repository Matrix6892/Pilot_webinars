<objective>
Не допустить смешения ролей моделей при построении eval и интерпретации результатов.
</objective>

<roles>
| Роль | Модель/компонент | Разрешено | Не разрешено |
|---|---|---|---|
| Vision observation | MiMo V2.5 | кратко описать непосредственно видимое и неопределённости | выбирать краску, материал, площадь, расход, цену или срок |
| Primary sales | официальный DeepSeek API `deepseek/deepseek-v4-flash`/max | разобрать заявку и вернуть draft по заданному JSON-контракту | обходить deterministic guard, использовать builtin webfetch или неоткрытые sources |
| Independent review | `deepseek/deepseek-v4-flash`/max отдельным вторым call без tools | проверить неизменяемый draft, источники, числа и полномочия | молча исправлять unsafe promise и одобрять blocking issue |
| Program guard | код «Колера» | нормализовать, пересчитать и fail closed | доверять model output как ground truth |
| Rule improvement | GPT-5.6 Sol вручную вне order runtime | анализировать выбранные наблюдаемые результаты и предлагать правила | обрабатывать рабочие заявки или становиться скрытым runtime stage |
</roles>

<comparison_controls>
- При сравнении primary models сохранять один reviewer и одну версию deterministic guard.
- При сравнении reviewer rules сохранять primary drafts recorded и неизменными.
- При сравнении vision rules использовать один набор изображений и human-verified visible facts.
- При сравнении prompt versions закрепить model id, temperature/configuration, snapshots и timeout policy.
- Не сравнивать offline fallback с search-enabled run как будто различается только модель.
- Для публичного web сравнения закрепить custom `public_webfetch`, HTTPS/DNS-pinned transport и одинаковые redirect/size/content-type limits.
</comparison_controls>

<failure_interpretation>
- Ошибка MiMo оценивается по observable visible facts, не по конечному product.
- Ошибка primary сохраняется даже если guard сделал конечный result безопасным; отдельно измерять raw draft и guarded result.
- Reviewer считается заблокировавшим угрозу, только если unsafe draft не приходит к ready/send path.
- Program guard является последним safety gate; его failure всегда critical.
- Sol proposal не получает production credit до regression test и сравнения на прежнем корпусе.
</failure_interpretation>

<success_criteria>
- Отчёт разделяет raw primary, guarded result и reviewer outcome.
- Ни одной модели не приписывается работа другого stage.
- GPT-5.6 Sol остаётся вне рабочего order pipeline.
</success_criteria>
