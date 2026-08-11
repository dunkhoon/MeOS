import { supabase } from './supabase'

export interface CalEvent {
  id: string
  calendar_id: string | null
  color: string | null
  title: string
  start_at: string
  end_at: string | null
  all_day: boolean
  location: string | null
  raw: { description?: string; htmlLink?: string; eventType?: string } | null
}

export async function fetchEvents(fromISO: string, toISO: string): Promise<CalEvent[]> {
  const { data, error } = await supabase
    .from('events')
    .select('id, calendar_id, color, title, start_at, end_at, all_day, location, raw')
    .gte('start_at', fromISO)
    .lte('start_at', toISO)
    .order('start_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as CalEvent[]
}
