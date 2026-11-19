# Worker Queue 分批检查

[English](#english)

Queue 将一轮到期检查拆成多次 Worker 调用，供较多普通主动监控和 AI 模型共用。它不提高单次调用的外部请求上限，也不会让检查免费；每次消费仍受请求、执行时间和 Analytics Engine 点数预算约束。

这是 Worker 独有的可选功能，默认关闭；未启用时继续使用原来的定时检查，不影响初始化、Go 后端、Push 和 Agent 上报。启用后如果绑定丢失或发送失败，不会自动切回直接检查；应恢复队列，或在后台明确关闭分批检查。

保留每分钟执行的 Cron。它仍负责入队、Push 超时、Agent 状态和通知，Queue 不取代这部分调度。

## 绑定并检查

1. 在 Cloudflare 控制台创建 Queue。
2. 为当前 Worker 添加 Queue producer 绑定，变量名为 `CHECK_QUEUE`，选择刚创建的队列。
3. 在队列的消费者设置中选择同一个 Worker。建议最大批大小为 **1 条消息**、最大并发为 **1**，等待时间可设为 5 秒。
4. 保存并部署，然后进入后台“设置 → 运维操作”，运行 Queue 连接检查。
5. 检查会发送一条不调用监控目标的探测消息，并等待消费者确认。检查通过后，再启用分批检查。只有 producer、没有 consumer 时不能通过。

“一条消息”与“一个监控”不同：程序每条消息最多携带 10 项任务，所以消费者的批大小设为 1 也能在一次调用里执行多项检查。不要为了增加吞吐直接把消费者批大小改为 100；它只会让更多任务挤进同一次调用，仍共用同一份预算。

Fork 与按钮部署会保留 `CHECK_QUEUE` 及属于当前 Worker 的消费者配置，包括等待、重试、并发和死信队列。读取现有配置失败时停止部署，避免误删绑定。部署不会自动创建队列、添加缺少的消费者，或接管其他 Worker 的消费者。

Cloudflare 控制台的入口可能随版本调整，参见[官方队列配置说明](https://developers.cloudflare.com/queues/configuration/configure-queues/)。

### 手动部署的配置

使用 CF CLI 手动部署时，还要把已创建的队列写入 `backends/worker/cloudflare.config.ts`，否则下一次部署可能覆盖控制台绑定。以下示例的实际队列名为 `polaris-checks`。在 `worker.env` 中增加：

```ts
CHECK_QUEUE: bindings.queue({ name: "polaris-checks" }),
```

在 `worker.triggers` 数组中增加消费者，保留原来的 Cron：

```ts
triggers.queue({
  name: "polaris-checks",
  maxBatchSize: 1,
  maxBatchTimeout: 5,
  maxConcurrency: 1,
}),
```

使用 Wrangler 配置时，对应字段如下；追加到实际部署使用的 TOML，不要改动已有数据库和其他资源配置：

```toml
[[queues.producers]]
binding = "CHECK_QUEUE"
queue = "polaris-checks"

[[queues.consumers]]
queue = "polaris-checks"
max_batch_size = 1
max_batch_timeout = 5
max_concurrency = 1
```

## 用量与费用

每条队列消息包含最多 10 项检查，不足 10 项时也会发送。消息写入、读取和删除分别计入 Queue 操作；正常成功处理一条消息通常消耗 3 次操作，重试和重新投递还会增加用量。把任务合并进同一条消息可以减少操作数，但不能保证每条消息都满载。

例如，100 个同时到期的任务，按每条 10 项且无重试计算，需要 10 条消息、30 次 Queue 操作。实际未满批次、分时调度和重投递都会增加用量。Worker 消费调用、数据库读写、AE 写入和供应商 API 调用仍分别计算。免费额度和价格以 [Cloudflare Queue 计费说明](https://developers.cloudflare.com/queues/platform/pricing/)为准。

**Queue 至少投递一次。** 程序会识别已经完成的任务，但消费者在供应商请求完成后、结果保存前中断时，重新投递仍可能再次调用供应商并收费。不要把应用侧去重理解为供应商侧的恰好一次计费。

## 观察积压与恢复

后台显示最近入队时间、最近处理时间、待处理任务数及最早待处理时间。结合 Cloudflare 队列指标确认消息是否持续消费，不能仅凭 producer 已绑定判断调度正常。

程序最多同时保留 1000 项待处理任务，单项有效期为 15 分钟。过期任务不补成检查结果，仍到期的监控等待下一轮入队。长超时任务可能分多次消费，不会为了塞进同一次调用而缩短配置的请求超时。

- 检查失败：确认 producer 和 consumer 指向同一队列、消费者是当前 Worker，保存部署后重新检查。
- 积压增长：检查消费者错误、目标响应时间、请求预算和 Cloudflare 用量；适当延长监控间隔。
- 模型限流或额度不足：仍按渠道冷却处理，不通过立即重新投递绕过退避。
- 暂停、删除或修改监控：旧任务不会用旧配置覆盖新状态，也不会把未执行任务记为成功或目标故障。

需要退回直接检查时，先在后台关闭分批检查，再调整绑定。已有队列可能仍有消息，不要删除队列来代替关闭功能。

## English

Queues split due checks across multiple Worker invocations for ordinary active monitors and AI models. They do not raise the per-invocation request limit or make checks free. Each consumer invocation still has request, execution-time and Analytics Engine budgets.

This optional Worker feature is disabled by default. Until explicitly enabled, the original scheduler continues. Setup, Go, Push and Agent reporting do not require it. If the binding disappears or sending fails after enablement, the application does not silently switch to direct checks; restore the Queue or explicitly disable batching.

Keep the per-minute Cron. It still handles enqueueing, Push timeouts, Agent state and notifications; Queue does not replace it.

### Bind and verify

1. Create a Queue in Cloudflare.
2. Add a producer binding named `CHECK_QUEUE` to the current Worker and select that Queue.
3. Add the same Worker as the Queue’s consumer. Start with a maximum batch size of **1 message**, concurrency **1**, and a five-second batch timeout.
4. Save and deploy, then run the Queue connection check under the console’s settings and operations section.
5. The check sends a probe message without calling monitoring targets and waits for the consumer to confirm it. Enable batched checks only after it passes. A producer without a consumer cannot pass.

One message is not one monitor: the application includes up to 10 tasks per message. Increasing consumer batch size packs more tasks into the same invocation; it does not give them separate budgets. See [Cloudflare’s configuration guide](https://developers.cloudflare.com/queues/configuration/configure-queues/).

Fork and button deployments preserve `CHECK_QUEUE` and the current Worker’s consumer settings, including timeout, retries, concurrency and dead-letter queue. Deployment stops if those settings cannot be read. It does not create resources, add missing consumers or take over another Worker’s consumer.

For manual CF CLI deployment, also declare the existing Queue in `backends/worker/cloudflare.config.ts`: add `CHECK_QUEUE: bindings.queue({ name: "polaris-checks" })` to `worker.env` and the `triggers.queue(...)` consumer shown above to `worker.triggers`, keeping the Cron. For Wrangler, add the producer and consumer TOML blocks above to the configuration actually used for deployment. Replace `polaris-checks` with your Queue name and retain existing database and resource configuration; otherwise a later manual deployment can overwrite dashboard-only bindings.

### Usage and charges

Messages carry up to 10 tasks, and partial messages still count. Writing, reading and deleting a message are separate Queue operations, so a normal successful delivery usually uses three operations. At 10 tasks per message without retries, 100 due tasks need 10 messages and 30 operations. Partial batches, staggered scheduling and redelivery increase usage. Consumer invocations, database access, AE and provider calls are billed separately. Check [current Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/).

**Delivery is at least once.** Completed tasks are deduplicated, but a consumer interrupted after a provider call and before saving its result can call that provider again on redelivery. Application deduplication does not guarantee exactly-once upstream billing.

### Backlog and recovery

The console reports last enqueue and processing times, pending tasks and the oldest pending task. Compare these with Cloudflare’s Queue metrics; a bound producer alone does not establish a working consumer.

The application retains up to 1000 pending tasks, each valid for 15 minutes. Expired tasks do not become check results; monitors still due can be enqueued on the next cycle. Long-timeout tasks may require separate consumer invocations rather than shortening their configured request timeouts.

If verification fails, confirm that the producer and current Worker consumer use the same Queue, save and deploy, then verify again. If backlog grows, inspect consumer errors, target duration, request budgets and platform usage; consider longer intervals. AI rate limits and quota failures retain their cooldown rather than retrying immediately. Paused, deleted, changed or unexecuted tasks do not overwrite current state or become successful checks or target failures.

To return to direct checks, disable batching in the console before changing bindings. Existing messages may remain; deleting the Queue is not a substitute for disabling the feature.
