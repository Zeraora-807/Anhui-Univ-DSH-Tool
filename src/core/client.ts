import { strEnc } from './des.ts'
import { HttpClient, type HttpResponse } from './http.ts'

const CAS_BASE = 'https://one.ahu.edu.cn/cas'
const JW_BASE = 'https://jw.ahu.edu.cn'
const JW_SSO = `${JW_BASE}/student/sso/login`
const SERVICE = JW_SSO
const JW_HOST = 'jw.ahu.edu.cn'
const CAS_HOST = 'one.ahu.edu.cn'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'


export interface AhuAcademicClientOptions {
  resolveCredentials: () => Promise<{ username: string; password: string }>
  rejectUnauthorized?: boolean
}

export interface SemesterInfo {
  id: number
  name: string
}

export class SessionExpiredError extends Error {
  constructor(message = 'AHU academic session expired') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

export class InvalidCredentialsError extends Error {
  constructor(message = '安徽大学统一身份认证：学号或密码错误') {
    super(message)
    this.name = 'InvalidCredentialsError'
  }
}

export class AhuAcademicClient {
  private readonly http: HttpClient
  private readonly options: AhuAcademicClientOptions
  private authPromise?: Promise<void>
  private gradeStudentId?: number
  private examStudentId?: number

  constructor(options: AhuAcademicClientOptions) {
    this.options = options
    const rejectUnauthorized = options.rejectUnauthorized ?? false
    this.http = new HttpClient(
      rejectUnauthorized ? new Set<string>() : new Set([CAS_HOST, JW_HOST]),
    )
  }

  async status(): Promise<Record<string, unknown>> {
    const { username, password } = await this.options.resolveCredentials()
    return {
      service: 'ahu-core',
      ready: Boolean(username && password),
      authenticated: Boolean(this.http.jar.get('SESSION', JW_HOST)),
      tlsVerification: (this.options.rejectUnauthorized ?? false) ? 'strict' : 'campus-compatibility',
    }
  }

  async authenticate(signal?: AbortSignal): Promise<void> {
    if (this.http.jar.get('SESSION', JW_HOST)) return
    if (this.authPromise) return this.authPromise

    const promise = this.performFullLogin(signal)
    this.authPromise = promise
    try {
      await promise
    } finally {
      if (this.authPromise === promise) this.authPromise = undefined
    }
  }

  async getSemesters(signal?: AbortSignal): Promise<SemesterInfo[]> {
    return this.withSessionRetry(async () => {
      const response = await this.jwRequest(`${JW_BASE}/student/for-std/course-table`, { signal })
      this.assertSuccessful(response, '学期列表')
      const semesters = parseSemestersHtml(response.body)
      if (semesters.length === 0) throw new Error('未从教务页面解析到学期列表')
      return semesters.sort((a, b) => b.id - a.id)
    }, signal)
  }

  async getSchedule(semesterId?: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.withSessionRetry(async () => {
      const resolvedSemesterId = await this.resolveSemesterId(semesterId, signal)
      const printUrl = `${JW_BASE}/student/for-std/course-table/semester/${resolvedSemesterId}/print-data` +
        `?semesterId=${resolvedSemesterId}&hasExperiment=false`
      const printResponse = await this.jwRequest(printUrl, {
        signal,
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
      })
      this.assertSuccessful(printResponse, '课表 print-data')
      const printData = parseJsonObject(printResponse.body, '课表 print-data')

      let enhancement: Record<string, unknown> | null = null
      let enhancementError: string | null = null
      try {
        const getDataUrl = `${JW_BASE}/student/for-std/course-table/get-data` +
          `?semesterId=${resolvedSemesterId}&dataId=22720&bizTypeId=2`
        const getDataResponse = await this.jwRequest(getDataUrl, {
          signal,
          headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
        })
        this.assertSuccessful(getDataResponse, '课表 get-data')
        enhancement = parseJsonObject(getDataResponse.body, '课表 get-data')
      } catch (error) {
        if (error instanceof SessionExpiredError) throw error
        enhancementError = errorMessage(error)
      }

      const tables = asArray(printData.studentTableVms)
      const studentTable = asRecord(tables[0])
      const activities = asArray(studentTable?.activities)
      const layout = asRecord(printData.timeTableLayout)
      const unitTimes = asArray(layout?.courseUnitList)
      const semesters = await this.getSemesters(signal)
      const semesterFromList = semesters.find(item => item.id === resolvedSemesterId) ?? null

      return {
        semesterId: resolvedSemesterId,
        semester: enhancement?.semester ?? semesterFromList,
        currentWeek: numberOrNull(enhancement?.currentWeek),
        weekIndices: asArray(enhancement?.weekIndices),
        activities,
        unitTimes,
        lessons: asArray(enhancement?.lessons),
        enhancementAvailable: enhancement !== null,
        enhancementError,
      }
    }, signal)
  }

  async getTodaySchedule(semesterId?: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const schedule = await this.getSchedule(semesterId, signal)
    const now = new Date()
    const weekday = now.getDay() === 0 ? 7 : now.getDay()
    const currentWeek = numberOrNull(schedule.currentWeek)
    const activities = filterActivities(asArray(schedule.activities), weekday, currentWeek)

    return {
      date: localDateString(now),
      weekday,
      currentWeek,
      semesterId: schedule.semesterId,
      semester: schedule.semester,
      activities: sortActivities(activities),
      unitTimes: schedule.unitTimes,
    }
  }

  async getWeekSchedule(week?: number, semesterId?: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const schedule = await this.getSchedule(semesterId, signal)
    const currentWeek = numberOrNull(schedule.currentWeek)
    const resolvedWeek = week ?? currentWeek
    if (resolvedWeek === null || !Number.isInteger(resolvedWeek) || resolvedWeek <= 0) {
      throw new Error('无法确定周次，请显式传入 week，例如 1、2、3')
    }

    const activities = asArray(schedule.activities).filter(activity => activityInWeek(activity, resolvedWeek))
    const days: Record<string, unknown[]> = {}
    for (let weekday = 1; weekday <= 7; weekday++) {
      days[String(weekday)] = sortActivities(
        activities.filter(activity => numberOrNull(asRecord(activity)?.weekday) === weekday),
      )
    }

    return {
      week: resolvedWeek,
      currentWeek,
      semesterId: schedule.semesterId,
      semester: schedule.semester,
      days,
      activities: sortActivities(activities),
      unitTimes: schedule.unitTimes,
    }
  }

  async getGrades(semesterId?: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.withSessionRetry(async () => {
      const bootstrapSemester = semesterId ?? await this.resolveSemesterId(undefined, signal)
      const studentId = await this.resolveGradeStudentId(bootstrapSemester, signal)
      const url = new URL(`${JW_BASE}/student/for-std/grade/sheet/info/${studentId}`)
      if (semesterId !== undefined) url.searchParams.set('semester', String(semesterId))
      const response = await this.jwRequest(url.toString(), {
        signal,
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
      })
      this.assertSuccessful(response, '成绩查询')
      return {
        semesterId: semesterId ?? null,
        data: sanitizeAcademicData(parseJson(response.body, '成绩查询')),
      }
    }, signal)
  }

  async getExams(includeFinished = true, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.withSessionRetry(async () => {
      const bootstrapSemester = await this.resolveSemesterId(undefined, signal)
      const studentId = await this.resolveExamStudentId(bootstrapSemester, signal)
      const response = await this.jwRequest(`${JW_BASE}/student/for-std/exam-arrange/info/${studentId}`, {
        signal,
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      })
      this.assertSuccessful(response, '考试安排')
      let exams = parseExamHtml(response.body)
      if (!includeFinished) exams = exams.filter(exam => exam.isFinished !== true)
      return {
        includeFinished,
        count: exams.length,
        exams,
        note: '教务 exam-arrange info 端点返回所有学期考试，结果可按时间或 isFinished 过滤。',
      }
    }, signal)
  }

  async getFreeRooms(
    campusId: string,
    buildingId: string,
    units: number[],
    date?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!campusId.trim()) throw new Error('campus_id 不能为空')
    if (!buildingId.trim()) throw new Error('building_id 不能为空')
    const normalizedUnits = normalizeUnits(units)
    const resolvedDate = date?.trim() || localDateString(new Date())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) throw new Error('date 必须为 YYYY-MM-DD')

    return this.withSessionRetry(async () => {
      const payload = JSON.stringify({
        buildingId,
        campusId,
        dateTimeSegmentCmd: {
          startDateTime: resolvedDate,
          endDateTime: resolvedDate,
          units: normalizedUnits.map(String),
        },
      })
      const response = await this.jwRequest(`${JW_BASE}/student/ws/room-borrow/free-list`, {
        method: 'POST',
        body: payload,
        signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json;charset=UTF-8',
          Referer: `${JW_BASE}/student/for-std/room-borrow`,
        },
      })
      this.assertSuccessful(response, '空教室查询')
      const data = parseJsonObject(response.body, '空教室查询')
      const rooms = asArray(data.roomList)
      return {
        campusId,
        buildingId,
        date: resolvedDate,
        units: normalizedUnits,
        count: rooms.length,
        rooms,
      }
    }, signal)
  }

  async getBuildingRooms(buildingId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!buildingId.trim()) throw new Error('building_id 不能为空')
    return this.withSessionRetry(async () => {
      const url = new URL(`${JW_BASE}/student/ws/room/get-rooms`)
      url.searchParams.set('buildingId', buildingId)
      url.searchParams.set('hasDataPermission', 'false')
      url.searchParams.set('hasUsableDepartPermission', 'false')
      const response = await this.jwRequest(url.toString(), {
        signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `${JW_BASE}/student/for-std/room-borrow`,
        },
      })
      this.assertSuccessful(response, '教学楼教室查询')
      const rooms = parseJson(response.body, '教学楼教室查询')
      if (!Array.isArray(rooms)) throw new Error('教学楼教室接口未返回数组')
      return { buildingId, count: rooms.length, rooms }
    }, signal)
  }

  private async performFullLogin(signal?: AbortSignal): Promise<void> {
    const { username, password } = await this.credentials()
    this.http.jar.clear()
    this.gradeStudentId = undefined
    this.examStudentId = undefined

    const loginUrl = new URL(`${CAS_BASE}/login`)
    loginUrl.searchParams.set('service', SERVICE)

    const loginPage = await this.http.request(loginUrl, {
      signal,
      headers: { 'User-Agent': UA },
    })
    if (loginPage.status < 200 || loginPage.status >= 300) {
      throw new Error(`CAS 登录页请求失败: HTTP ${loginPage.status}`)
    }

    const lt = extractInputValue(loginPage.body, 'lt')
    const execution = extractInputValue(loginPage.body, 'execution')
    if (!lt) throw new Error('CAS 登录页未找到 lt 字段')
    if (!execution) throw new Error('CAS 登录页未找到 execution 字段')

    const encrypted = strEnc(username + password + lt, '1', '2', '3')
    const ul = username.length
    const pl = password.length

    const deviceBody = new URLSearchParams({
      ul: String(ul),
      pl: String(pl),
      rsa: encrypted,
      method: 'login',
    }).toString()
    const deviceResponse = await this.http.request(`${CAS_BASE}/device`, {
      method: 'POST',
      body: deviceBody,
      signal,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(deviceBody),
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: loginUrl.toString(),
      },
    })
    this.assertHttp2xx(deviceResponse, 'CAS device 验证')
    const deviceJson = parseJsonObject(deviceResponse.body, 'CAS device 验证')
    const info = String(deviceJson.info ?? '')
    if (info === 'nf') throw new InvalidCredentialsError()
    if (info === 'err') throw new Error('安徽大学统一身份认证：登录验证失败，请稍后重试')
    if (info !== 'ok') throw new Error(`安徽大学统一身份认证：设备验证失败 (${info || 'unknown'})`)

    const submitBody = new URLSearchParams({
      rsa: encrypted,
      ul: String(ul),
      pl: String(pl),
      lt,
      execution,
      _eventId: 'submit',
    }).toString()
    const submitResponse = await this.http.request(loginUrl, {
      method: 'POST',
      body: submitBody,
      signal,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(submitBody),
        Referer: loginUrl.toString(),
      },
    })
    if (submitResponse.status < 300 || submitResponse.status >= 400) {
      throw new Error(`CAS 表单提交失败: HTTP ${submitResponse.status}`)
    }

    const castgc = this.http.jar.get('CASTGC', CAS_HOST)
    if (!castgc) throw new Error('CAS 登录成功响应中未获取到 CASTGC')

    const ticketResponse = await this.http.request(loginUrl, {
      signal,
      headers: {
        'User-Agent': UA,
        Cookie: `CASTGC=${castgc}`,
      },
    })
    const location = ticketResponse.headers.location
    if (!location) throw new Error('CAS 未返回 JW service ticket 的 Location')
    const ticketUrl = new URL(location, loginUrl)
    const ticket = ticketUrl.searchParams.get('ticket') ?? /[?&]ticket=([^&]+)/.exec(location)?.[1]
    if (!ticket) throw new Error('CAS 登录未返回有效 service ticket')

    await this.http.request(`${JW_SSO}?ticket=${encodeURIComponent(ticket)}`, {
      signal,
      followRedirects: true,
      headers: { 'User-Agent': UA },
    })

    if (!this.http.jar.get('SESSION', JW_HOST)) {
      throw new Error('JW SSO 完成后未获取到 SESSION cookie')
    }
  }

  private async credentials(): Promise<{ username: string; password: string }> {
    const { username, password } = await this.options.resolveCredentials()
    if (!username || !password) {
      throw new Error('AHU Academic Core currently has no login credentials.')
    }
    return { username, password }
  }

  private async withSessionRetry<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.authenticate(signal)
    try {
      return await work()
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error
      this.http.jar.clear()
      this.gradeStudentId = undefined
      this.examStudentId = undefined
      await this.authenticate(signal)
      return work()
    }
  }

  private async jwRequest(
    url: string,
    options: {
      method?: string
      headers?: Record<string, string | number>
      body?: string
      signal?: AbortSignal
    } = {},
  ): Promise<HttpResponse> {
    const response = await this.http.request(url, {
      ...options,
      followRedirects: false,
      headers: {
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        ...options.headers,
      },
    })
    if (isSessionExpiredResponse(response)) throw new SessionExpiredError()
    return response
  }

  private async resolveSemesterId(semesterId: number | undefined, signal?: AbortSignal): Promise<number> {
    if (semesterId !== undefined) {
      if (!Number.isInteger(semesterId) || semesterId <= 0) throw new Error('semester_id 必须为正整数')
      return semesterId
    }
    const semesters = await this.getSemesters(signal)
    if (semesters.length === 0) throw new Error('没有可用学期')
    return semesters[0].id
  }

  private async resolveGradeStudentId(bootstrapSemester: number, signal?: AbortSignal): Promise<number> {
    if (this.gradeStudentId !== undefined) return this.gradeStudentId
    const response = await this.jwRequest(
      `${JW_BASE}/student/for-std/grade/sheet?semesterId=${bootstrapSemester}`,
      { signal },
    )
    const id = parseStudentIdFromLocation(response.headers.location)
    if (id === null) throw new Error('无法解析成绩查询所需的内部学生标识')
    this.gradeStudentId = id
    return id
  }

  private async resolveExamStudentId(bootstrapSemester: number, signal?: AbortSignal): Promise<number> {
    if (this.examStudentId !== undefined) return this.examStudentId
    const response = await this.jwRequest(
      `${JW_BASE}/student/for-std/exam-arrange?semesterId=${bootstrapSemester}`,
      { signal },
    )
    const id = parseStudentIdFromLocation(response.headers.location)
    if (id === null) throw new Error('无法解析考试查询所需的内部学生标识')
    this.examStudentId = id
    return id
  }

  private assertSuccessful(response: HttpResponse, label: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${label}失败: HTTP ${response.status}`)
    }
    if (!response.body.trim()) throw new Error(`${label}返回空响应`)
  }

  private assertHttp2xx(response: HttpResponse, label: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${label}失败: HTTP ${response.status}`)
    }
  }
}

export function parseSemestersHtml(html: string): SemesterInfo[] {
  const select = /<select\b[^>]*\bid=["']allSemesters["'][^>]*>([\s\S]*?)<\/select>/i.exec(html)?.[1]
  if (!select) return []
  const result: SemesterInfo[] = []
  const optionRegex = /<option\b[^>]*\bvalue=["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/gi
  for (const match of select.matchAll(optionRegex)) {
    result.push({ id: Number(match[1]), name: decodeHtml(stripTags(match[2])).trim() })
  }
  return result
}

export interface ParsedExam {
  id: string
  courseName: string
  examType: string
  examTime: string
  campus: string
  building: string
  room: string
  seatNumber: string | null
  status: string
  isFinished: boolean
}

export function parseExamHtml(html: string): ParsedExam[] {
  const seatMap = extractSeatMap(html)
  const table = /<table\b[^>]*\bid=["']exams["'][^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]
  if (!table) return []

  const exams: ParsedExam[] = []
  const rowRegex = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi
  for (const rowMatch of table.matchAll(rowRegex)) {
    const attrs = rowMatch[1]
    const rowBody = rowMatch[2]
    const className = getAttribute(attrs, 'class') ?? ''
    if (!/(?:^|\s)(finished|unfinished)(?:\s|$)/.test(className)) continue

    const tds = [...rowBody.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1])
    if (tds.length < 2) continue

    const timeHtml = /<[^>]+\bclass=["'][^"']*\btime\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(tds[0])?.[1] ?? ''
    const examTime = textContent(timeHtml)
    const spans = [...tds[0].matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)]
      .map(match => ({ attrs: match[1], text: textContent(match[2]) }))
    const locationTexts = spans.map(item => item.text).filter(text => text && !text.startsWith('座位'))
    const campus = locationTexts[0] ?? ''
    const building = locationTexts[1] ?? ''
    const room = locationTexts[2] ?? ''
    const seatRecordId = /\bid=["']seat-(\d+)["']/i.exec(tds[0])?.[1]
    const seatNumber = seatRecordId ? seatMap.get(Number(seatRecordId))?.toString() ?? null : null

    const secondSpans = [...tds[1].matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)]
    const courseName = secondSpans.length > 0 ? textContent(secondSpans[0][2]) : textContent(tds[1])
    let examType = ''
    for (const span of secondSpans) {
      const cls = getAttribute(span[1], 'class') ?? ''
      if (/(?:^|\s)tag-span(?:\s|$)/.test(cls)) {
        examType = textContent(span[2])
        break
      }
    }

    const status = tds[2] ? textContent(tds[2]) : ''
    const isFinished = /(?:^|\s)finished(?:\s|$)/.test(className) ||
      status.includes('完成') || status.includes('已考') || status.includes('已结束')
    if (!courseName && !examTime) continue

    exams.push({
      id: stableExamId(courseName, examTime, room),
      courseName,
      examType,
      examTime,
      campus,
      building,
      room,
      seatNumber,
      status,
      isFinished,
    })
  }
  return exams
}

function extractSeatMap(html: string): Map<number, number> {
  const result = new Map<number, number>()
  const body = /var\s+studentExamList\s*=\s*\[([\s\S]*?)\];/i.exec(html)?.[1]
  if (!body) return result
  for (const objectText of splitTopLevelObjects(body)) {
    const id = /["']id["']\s*:\s*(\d+)/.exec(objectText)?.[1]
    const seatNo = /["']seatNo["']\s*:\s*(\d+)/.exec(objectText)?.[1]
    if (id && seatNo) result.set(Number(id), Number(seatNo))
  }
  return result
}

function splitTopLevelObjects(text: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = -1
  let quote: string | null = null
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        result.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return result
}

function isSessionExpiredResponse(response: HttpResponse): boolean {
  const location = response.headers.location ?? ''
  if (response.status >= 300 && response.status < 400 && /one\.ahu\.edu\.cn\/cas|\/cas\/login/i.test(location)) {
    return true
  }
  if (response.status === 200 && /name=["']lt["']/i.test(response.body) && /name=["']execution["']/i.test(response.body)) {
    return true
  }
  return false
}

function parseStudentIdFromLocation(location: string | string[] | undefined): number | null {
  const value = Array.isArray(location) ? location[0] : location
  if (!value) return null
  const match = /\/(?:semester-index|info)\/(\d+)(?:[/?#]|$)/.exec(value) ?? /\/(\d+)(?:[/?#]|$)/.exec(value)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) ? parsed : null
}

function extractInputValue(html: string, name: string): string | null {
  const inputRegex = /<input\b([^>]*)>/gi
  for (const match of html.matchAll(inputRegex)) {
    if (getAttribute(match[1], 'name') !== name) continue
    return decodeHtml(getAttribute(match[1], 'value') ?? '')
  }
  return null
}

function getAttribute(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i')
  return regex.exec(attrs)?.[2] ?? null
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${label}返回非 JSON`)
  }
}

function parseJsonObject(body: string, label: string): Record<string, unknown> {
  const value = parseJson(body, label)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}未返回 JSON 对象`)
  return value as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function filterActivities(activities: unknown[], weekday: number, week: number | null): unknown[] {
  return activities.filter(activity => {
    const record = asRecord(activity)
    if (!record || numberOrNull(record.weekday) !== weekday) return false
    return week === null || activityInWeek(activity, week)
  })
}

function activityInWeek(activity: unknown, week: number): boolean {
  const record = asRecord(activity)
  if (!record) return false
  const indices = asArray(record.weekIndexes).map(numberOrNull).filter((value): value is number => value !== null)
  return indices.length === 0 || indices.includes(week)
}

function sortActivities(activities: unknown[]): unknown[] {
  return [...activities].sort((a, b) => {
    const ar = asRecord(a)
    const br = asRecord(b)
    const aw = numberOrNull(ar?.weekday) ?? 99
    const bw = numberOrNull(br?.weekday) ?? 99
    if (aw !== bw) return aw - bw
    const asu = numberOrNull(ar?.startUnit) ?? 99
    const bsu = numberOrNull(br?.startUnit) ?? 99
    return asu - bsu
  })
}

function normalizeUnits(units: number[]): number[] {
  const source = units.length > 0 ? units : Array.from({ length: 13 }, (_, index) => index + 1)
  const unique = [...new Set(source)]
  for (const unit of unique) {
    if (!Number.isInteger(unit) || unit < 1 || unit > 13) throw new Error('units 只能包含 1 到 13 的整数')
  }
  return unique.sort((a, b) => a - b)
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function textContent(html: string): string {
  return decodeHtml(stripTags(html)).replace(/\s+/g, ' ').trim()
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function stableExamId(courseName: string, examTime: string, room: string): string {
  const text = `${courseName}|${examTime}|${room}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `e${(hash >>> 0).toString(16)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
