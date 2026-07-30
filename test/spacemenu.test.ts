import { describe, it, expect } from 'vitest'
import { acceleratorLabel, canDeleteSpace } from '../src/renderer/components/SpaceMenu'

describe('acceleratorLabel', () => {
  it('labels the first nine indices Ctrl+1..Ctrl+9', () => {
    expect(acceleratorLabel(0)).toBe('Ctrl+1')
    expect(acceleratorLabel(8)).toBe('Ctrl+9')
  })

  it('has no label past the ninth index or below zero', () => {
    expect(acceleratorLabel(9)).toBeNull()
    expect(acceleratorLabel(-1)).toBeNull()
  })
})

describe('canDeleteSpace', () => {
  it('refuses when it is the only space', () => {
    expect(canDeleteSpace(1)).toBe(false)
  })

  it('allows deletion once more than one space exists', () => {
    expect(canDeleteSpace(2)).toBe(true)
  })
})
