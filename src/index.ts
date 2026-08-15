import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { AhuCoreBridge } from './bridge.ts'

export const name = 'tool-ahu-academic'
export const inject = ['tools']

const AUTH_TIMEOUT_MS = 6 * 60 * 1000

// Authorization is remembered only in memory for this Agent instance.
const authorizedAgents = new WeakSet<object>()

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

async function requireAuthorization(
  ctx: Context,
  exec: ToolExecution,
  toolName: string,
): Promise<void> {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('AHU Academic authorization requires an agent-backed session.')
  }

  if (authorizedAgents.has(agent)) return

  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('AHU Academic requires the DSH user-approval service.')
  }

  const outcome = await approval.request({
    agent,
    toolName,
    callId: exec.callId,
    reason:
      'Allow this AHU Academic tool call to access your locally stored Anhui University academic account. '
      + 'If no saved login exists, a local authorization page will open at 127.0.0.1:3090. '
      + 'Credentials are handled by the isolated local core and are never passed to the model.',
    signal: exec.signal,
  })

  if (outcome !== 'allowed-once') {
    const error = new Error(`AHU Academic authorization was not granted (${outcome}).`)
    Object.assign(error, { code: 'AHU_AUTHORIZATION_DENIED' })
    throw error
  }

  authorizedAgents.add(agent)
}

async function invoke(
  ctx: Context,
  bridge: AhuCoreBridge,
  exec: ToolExecution,
  toolName: string,
  method: string,
  params: Record<string, unknown>,
): Promise<JsonValue> {
  await requireAuthorization(ctx, exec, toolName)
  return jsonValue(await bridge.call(method, params, exec.signal))
}

export function apply(ctx: Context): void {
  const bridge = new AhuCoreBridge()
  ctx.effect(() => () => bridge.dispose())

  ctx.tools.register(defineTool({
    name: 'ahu_plugin_status',
    description:
      'Check whether the native AHU Academic tool package is loaded. '
      + 'This status check does not access the academic account or credentials.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute() {
      return jsonValue({
        loaded: true,
        package: '@deepseek-ai/dsh-tool-ahu-academic',
        authorization: 'DSH approval required once per Agent instance',
        loginUi: '127.0.0.1:3090, opened automatically only when login is needed',
        credentialStorage: process.platform === 'win32'
          ? 'Windows DPAPI, current-user scope'
          : 'Windows-only persistent storage',
        powershellRequired: false,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_semesters',
    description: 'Get academic semesters available in the current Anhui University academic account.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(_args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_semesters', 'semesters', {})
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_schedule',
    description: 'Get the full Anhui University course schedule. If semester_id is omitted, the latest available semester is used.',
    parameters: {
      semester_id: { type: 'number', description: 'Optional numeric semester ID returned by ahu_get_semesters.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_schedule', 'schedule', {
        semesterId: args.semester_id,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_today_schedule',
    description: "Get today's Anhui University courses using the current teaching week and local weekday.",
    parameters: {
      semester_id: { type: 'number', description: 'Optional numeric semester ID.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_today_schedule', 'schedule.today', {
        semesterId: args.semester_id,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_week_schedule',
    description: 'Get courses for a teaching week. If week is omitted, AHU JW current week is used.',
    parameters: {
      week: { type: 'number', description: 'Optional positive teaching-week number.' },
      semester_id: { type: 'number', description: 'Optional numeric semester ID.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_week_schedule', 'schedule.week', {
        week: args.week,
        semesterId: args.semester_id,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_grades',
    description: 'Get Anhui University grades. Personal account identifiers are removed before the result reaches the model.',
    parameters: {
      semester_id: { type: 'number', description: 'Optional numeric semester ID. Omit for all semesters.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_grades', 'grades', {
        semesterId: args.semester_id,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_exams',
    description: 'Get Anhui University exam arrangements including time, campus, room and seat number when available.',
    parameters: {
      include_finished: { type: 'boolean', description: 'Include already-finished exams. Defaults to true.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_exams', 'exams', {
        includeFinished: args.include_finished ?? true,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_free_rooms',
    description: 'Query empty Anhui University classrooms for a campus, building, date and class units.',
    parameters: {
      campus_id: { type: 'string', required: true, description: 'JW campus ID.' },
      building_id: { type: 'string', required: true, description: 'JW teaching-building ID.' },
      date: { type: 'string', description: 'Optional date in YYYY-MM-DD. Defaults to today.' },
      units: {
        type: 'array',
        description: 'Optional class-unit numbers from 1 to 13. Empty means all units.',
        items: { type: 'number' },
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_free_rooms', 'rooms.free', {
        campusId: args.campus_id,
        buildingId: args.building_id,
        date: args.date,
        units: args.units ?? [],
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ahu_get_building_rooms',
    description: 'Get enabled rooms in an Anhui University teaching building.',
    parameters: {
      building_id: { type: 'string', required: true, description: 'JW teaching-building ID.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    timeoutMs: AUTH_TIMEOUT_MS,
    async execute(args, exec) {
      return invoke(ctx, bridge, exec, 'ahu_get_building_rooms', 'rooms.building', {
        buildingId: args.building_id,
      })
    },
  }))
}
