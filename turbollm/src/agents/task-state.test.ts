import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentTaskState } from './task-state'

// A background task shows in /status (`agentTasks`); an open page hears each change instead of waiting on a slow poll.
test('starting, stepping and finishing a task each announce status', () => {
  const heard: string[] = []
  const tasks = new AgentTaskState((key) => heard.push(key))
  const id = tasks.start('review', 'a1', 'Reflecting on this task', 'c1')
  assert.deepEqual(heard.splice(0), ['status'])
  tasks.step(id, 'reading the transcript')
  assert.deepEqual(heard.splice(0), ['status'])
  tasks.done(id, 'nothing to learn')
  assert.deepEqual(heard.splice(0), ['status'])

  const failing = tasks.start('skill_from_folder', 'a1', 'Learning from /docs')
  heard.length = 0
  tasks.fail(failing, 'boom')
  assert.deepEqual(heard.splice(0), ['status'])
})

test('a write to an unknown task announces nothing', () => {
  const heard: string[] = []
  const tasks = new AgentTaskState((key) => heard.push(key))
  tasks.step('missing', 'x')
  tasks.done('missing', 'x')
  tasks.fail('missing', 'x')
  assert.deepEqual(heard, [])
})
