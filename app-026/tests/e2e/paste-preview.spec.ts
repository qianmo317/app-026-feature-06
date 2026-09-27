import { test, expect } from '@playwright/test'
import { createScriptViaUI, SAMPLE_SCRIPT } from './helpers'

test.describe('粘贴导入预览', () => {
  test.beforeEach(async ({ page }) => {
    await createScriptViaUI(page, '预览E2E', SAMPLE_SCRIPT)
  })

  test('预览逐行标出问题、可就地改角色与秒数、确认后才写入；追加标出承接段', async ({ page }) => {
    const linesBefore = await page.getByTestId('line-row').count()

    await page.getByTestId('paste-input').fill(
      '## 加演段\n年迈的老丞相诸葛亮：我本是卧龙岗散淡的人【过门0】\n旦：凭阴阳如反掌保定乾坤【过门x】\n生：琴童【停顿3\n',
    )

    // ---- 追加预览：标出承接段 ----
    await page.getByTestId('btn-parse-append').click()
    await expect(page.getByTestId('paste-preview')).toBeVisible()
    await expect(page.getByTestId('pv-summary')).toContainText('共 1 段 · 3 句')
    await expect(page.getByTestId('pv-anchor')).toContainText('第二段')
    // 三类问题各出现一次
    await expect(page.getByTestId('pv-issue-role-long')).toHaveCount(1)
    await expect(page.getByTestId('pv-issue-seconds-zero')).toHaveCount(1)
    await expect(page.getByTestId('pv-issue-seconds-nan')).toHaveCount(1)
    await expect(page.getByTestId('pv-issue-unpaired-bracket')).toHaveCount(1)
    // 取消：正文不动
    await page.getByTestId('pv-cancel').click()
    await expect(page.getByTestId('line-row')).toHaveCount(linesBefore)

    // ---- 替换预览：就地修复 ----
    await page.getByTestId('btn-parse-replace').click()
    await expect(page.getByTestId('paste-preview')).toBeVisible()
    await expect(page.getByTestId('pv-anchor')).toContainText('替换全篇')

    // 角色超六字：填角色后提示消失、前缀被剥掉
    const firstRow = page.getByTestId('pv-row').filter({ hasText: '散淡的人' })
    await firstRow.getByLabel('角色').fill('生')
    await expect(page.getByTestId('pv-issue-role-long')).toHaveCount(0)
    await expect(firstRow).toContainText('我本是卧龙岗散淡的人')

    // 秒数为零：改成 4 后提示消失
    await page.locator('.cue-chip.cue-warn input').first().fill('4')
    await expect(page.getByTestId('pv-issue-seconds-zero')).toHaveCount(0)

    // 秒数非数字：补成 6 并识别为标记
    const nanRow = page.getByTestId('pv-row').filter({ hasText: '保定乾坤' })
    await nanRow.getByTestId('pv-fix-seconds').fill('6')
    await nanRow.getByTestId('pv-fix-adopt').click()
    await expect(page.getByTestId('pv-issue-seconds-nan')).toHaveCount(0)
    await expect(nanRow.locator('.cue-chip[data-kind=interlude] input')).toHaveValue('6')

    // 确认写入：正文被替换为预览内容
    await page.getByTestId('pv-confirm').click()
    await expect(page.getByTestId('paste-preview')).toBeHidden()
    await expect(page.getByTestId('line-row')).toHaveCount(3)
    // 段头标题来自粘贴内容
    await expect(page.getByTestId('segment-header').first().locator('input.seg-title')).toHaveValue('加演段')
    // 未配对括号的片段无法识别为标记，原文保留在唱词里
    await expect(page.getByTestId('line-row').nth(2).locator('input.line-text')).toHaveValue(/琴童.*停顿3/)
  })
})
