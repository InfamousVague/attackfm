import { useMemo, useState } from 'react';
import { Pill, SearchField, Switch, Text } from '@glacier/react';
import { CircleAlert, CircleCheck, CircleX, FlaskConical, MinusCircle } from '@glacier/icons';
import { PaneSection, SettingRow, SettingsCallout, SettingsFootnote } from './kit/settingsKit.tsx';
import {
  buildCommit,
  buildMatch,
  suiteDidNotRun,
  tallyReport,
  testReport,
  type TestCase,
  type TestReport,
  type TestSuite,
  type SuiteStatus,
  type TestStatus,
} from '../diag/testReport.ts';
import type { Translate } from './settingsShared.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatAgo, formatDate, formatNumber } from '../ux/format.ts';

/**
 * The test report this build shipped with, on the device.
 *
 * WHY IT EXISTS. "The tests pass" is a claim somebody makes in a chat message
 * about a machine you are not sitting at, and by the time an app is on a phone
 * there is no terminal to check it against. The generator writes the run down
 * beside the code; this pane reads it back out where the app is actually
 * running, so the claim and the binary can be compared by one person holding
 * one device.
 *
 * THE ONE THING IT MUST NEVER DO is show a green tick over somebody else's
 * build. A report is a file, and a file survives the code around it changing:
 * it is trivially possible to be looking at a beautiful all-green run of a
 * commit that has nothing to do with the bytes on this phone, and that is
 * worse than having no pane at all, because it manufactures confidence. So
 * three things are said in red before anything green is said at all - the
 * report belonging to another commit, a suite that never produced a result,
 * and a tree that was dirty when the run happened - and the verdict itself is
 * recomputed from the suites rather than read off the report's own `ok`
 * (see `diag/testReport.ts`).
 *
 * WHY EVERYTHING IS CLOSED. A full run is around 1,700 rows. Opened at once
 * that is not a page anybody reads, it is a page people scroll past, and it
 * costs a render nobody asked for. So: suites, then files, then test names,
 * each closed - EXCEPT the failures, which sort to the top and open
 * themselves. The only reason to come here in a hurry is a red one, and it
 * should be the first thing under the thumb.
 */

/* Names the generator writes, matched here, never shown. i18n-ignore */
const CARGO = 'cargo:';

/** The suite's name in the reader's language, chosen by ID.
 *
 *  By ID and not by `suite.title`: the title is an English label the
 *  generator wrote, and translating a string that arrives in a data file
 *  means a catalogue that has to be edited every time somebody renames a
 *  suite. A runner this pane has not been taught about falls back to that
 *  label, which is the honest answer - an English word from the report,
 *  rather than a missing-key blank. */
function suiteLabel(suite: TestSuite, t: Translate): string {
  if (suite.id === 'vitest') return t('settings.testsSuiteUnit');
  if (suite.id === 'playwright:fast') return t('settings.testsSuiteBrowserFast');
  if (suite.id === 'playwright:slow') return t('settings.testsSuiteBrowserSlow');
  if (suite.id.startsWith(CARGO)) {
    return t('settings.testsSuiteRust', { target: suite.id.slice(CARGO.length) });
  }
  return suite.title;
}

function suiteStatusWord(status: SuiteStatus, t: Translate): string {
  if (status === 'passed') return t('settings.testsStatusPassed');
  if (status === 'failed') return t('settings.testsStatusFailed');
  if (status === 'error') return t('settings.testsStatusErrored');
  return t('settings.testsStatusNeverRan');
}

function suiteStatusTone(status: SuiteStatus): 'success' | 'danger' | 'warning' {
  if (status === 'passed') return 'success';
  // `notRun` is amber rather than red on the pill alone - the red is spent on
  // the banner above, which says the thing that matters: no result at all.
  if (status === 'notRun') return 'warning';
  return 'danger';
}

function caseStatusWord(status: TestStatus, t: Translate): string {
  if (status === 'passed') return t('settings.testsStatusPassed');
  if (status === 'failed') return t('settings.testsStatusFailed');
  if (status === 'skipped') return t('settings.testsStatusSkipped');
  return t('settings.testsStatusTodo');
}

/** A duration, through Intl rather than the catalogue: which side of the
 *  number the unit sits on is a locale's decision, not ours. Seconds once it
 *  is long enough that milliseconds are noise. */
function took(ms: number): string {
  if (ms >= 10_000) {
    return formatNumber(ms / 1000, {
      style: 'unit',
      unit: 'second',
      maximumFractionDigits: 1,
    });
  }
  return formatNumber(Math.round(ms), { style: 'unit', unit: 'millisecond' });
}

interface FileGroup {
  file: string;
  tests: TestCase[];
  failed: number;
}

/** One suite, its cases bucketed by file, failures first at both levels. */
interface SuiteView {
  suite: TestSuite;
  files: FileGroup[];
  shown: number;
  failed: number;
}

/** AND across words, over the test name AND its file - the same rule the rest
 *  of settings searches by, and a file path is the other half of what somebody
 *  types when they are hunting one case. */
function caseMatches(c: TestCase, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${c.name} ${c.file}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

function buildViews(suites: TestSuite[], query: string, onlyFailures: boolean): SuiteView[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const views = suites.map((suite) => {
    const byFile = new Map<string, TestCase[]>();
    for (const c of suite.tests) {
      if (onlyFailures && c.status !== 'failed') continue;
      if (!caseMatches(c, words)) continue;
      const bucket = byFile.get(c.file);
      if (bucket) bucket.push(c);
      else byFile.set(c.file, [c]);
    }
    const files: FileGroup[] = [...byFile.entries()].map(([file, tests]) => ({
      file,
      // Inside a file too: the failure is why anyone opened this.
      tests: [...tests].sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed')),
      failed: tests.filter((c) => c.status === 'failed').length,
    }));
    files.sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0));
    return {
      suite,
      files,
      shown: files.reduce((n, f) => n + f.tests.length, 0),
      failed: files.reduce((n, f) => n + f.failed, 0),
    };
  });
  /*
   * Suites in trouble first, everything else in the generator's own order.
   * A stable partition rather than a full sort: within each band the report's
   * order is the run's order, and shuffling that would hide which suite the
   * run actually reached first.
   *
   * The band is decided by the SUITE's own status, never by what survived the
   * filter. Read off the filtered count instead and typing a word that misses
   * the failure demotes the suite holding it - the list reshuffles under the
   * hand that is still typing, which is the one moment a stable order is
   * worth most.
   */
  const inTrouble = (v: SuiteView) => v.suite.status !== 'passed';
  return [...views.filter(inTrouble), ...views.filter((v) => !inTrouble(v))];
}

/** A file's key inside its suite. One string rather than a nested map: a
 *  suite id never contains a space, so the first one is the seam and two
 *  different (suite, file) pairs cannot collide on it. */
function groupKey(suiteId: string, file: string): string {
  return `${suiteId} ${file}`;
}

/** The groups that stand open before anybody touches anything: the suites that
 *  went wrong, and inside them the files that hold the failures. */
function defaultOpen(views: SuiteView[]): Set<string> {
  const keys = new Set<string>();
  for (const v of views) {
    if (v.failed === 0 && !suiteDidNotRun(v.suite)) continue;
    keys.add(v.suite.id);
    for (const f of v.files) if (f.failed > 0) keys.add(groupKey(v.suite.id, f.file));
  }
  return keys;
}

interface TestResultsPaneProps {
  /** Defaults to the report this build shipped with. A prop only so a suite
   *  can hand it one - Settings renders this with no props at all. */
  report?: TestReport;
  /** The commit Vite stamped into this build; null when it carries none.
   *  Same reason: a compile-time constant cannot be varied from a test, and
   *  the mismatch banner is the behaviour that most needs proving. */
  buildCommit?: string | null;
}

export function TestResultsPane({
  report = testReport,
  buildCommit: mine = buildCommit(),
}: TestResultsPaneProps = {}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [onlyFailures, setOnlyFailures] = useState(false);
  /*
   * The open set is seeded ONCE, from the unfiltered report, and never
   * re-seeded. A set that re-derived itself from the current filter would
   * throw away every group the reader had opened by hand the moment they typed
   * a character - and the filter's own auto-open (below) already covers the
   * case it would have been trying to solve.
   */
  const [open, setOpen] = useState<Set<string>>(() =>
    defaultOpen(buildViews(report.suites, '', false)),
  );

  const tally = useMemo(() => tallyReport(report), [report]);
  const match = buildMatch(report, mine);
  const missing = report.suites.filter(suiteDidNotRun);
  const filtering = query.trim().length > 0 || onlyFailures;
  const views = useMemo(
    () => buildViews(report.suites, query, onlyFailures),
    [report, query, onlyFailures],
  );
  const totalShown = views.reduce((n, v) => n + v.shown, 0);

  /* While a filter is on, whatever survived it is open. Narrowing a list to
     four rows and then hiding all four behind a closed group is a filter that
     appears to have found nothing. */
  const isOpen = (key: string) => (filtering ? true : open.has(key));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const ran = Date.parse(report.generatedAt);
  const tools = Object.entries(report.tools);

  return (
    <div className="prefsBody testPane">
      {/*
        The verdict, before the provenance and before the banners in the
        markup - but read AFTER them on screen, because a person's eye lands on
        the red first and that is the order this page needs. The tick is only
        ever drawn when the sum of the suites says so: `report.ok` is a fact
        further down, not the thing this line is made of.
      */}
      <div className="testPane__verdict" data-ok={tally.ok || undefined}>
        <span className="testPane__verdictGlyph" aria-hidden>
          {tally.ok ? <CircleCheck size={26} /> : <CircleX size={26} />}
        </span>
        <div className="testPane__verdictBody">
          <div className="testPane__verdictLine">
            {tally.ok
              ? t('settings.testsAllPassed', {
                  count: tally.passed,
                  n: formatNumber(tally.passed),
                })
              : tally.failed > 0
                ? t('settings.testsSomeFailed', {
                    count: tally.failed,
                    n: formatNumber(tally.failed),
                  })
                : t('settings.testsNoVerdict')}
          </div>
          <div className="testPane__tallies">
            <span className="testPane__tally">
              <span className="testPane__tallyN">{formatNumber(tally.passed)}</span>
              {t('settings.testsStatusPassed')}
            </span>
            {/* A ZERO IS NOT AN ALARM. Colouring these red whatever they say
                puts "0 Failed" on screen in the same red as "3 Failed", which
                spends the one colour that has to mean something. */}
            <span className="testPane__tally" data-alarm={tally.failed > 0 || undefined}>
              <span className="testPane__tallyN">{formatNumber(tally.failed)}</span>
              {t('settings.testsStatusFailed')}
            </span>
            <span className="testPane__tally">
              <span className="testPane__tallyN">{formatNumber(tally.skipped + tally.todo)}</span>
              {t('settings.testsStatusSkipped')}
            </span>
            <span className="testPane__tally" data-alarm={tally.suitesMissing > 0 || undefined}>
              <span className="testPane__tallyN">{formatNumber(tally.suitesMissing)}</span>
              {t('settings.testsStatusNeverRan')}
            </span>
          </div>
        </div>
      </div>

      {/* THE THREE RED ONES. Each says what is wrong with the report itself
          rather than with the code, which is the distinction that makes a
          green tick above worth anything. */}
      {match === 'mismatch' && (
        <SettingsCallout tone="danger" icon={<CircleAlert size={18} />}>
          {t('settings.testsWrongBuild', { report: report.commit, build: mine ?? '' })}
        </SettingsCallout>
      )}
      {match === 'unknown' && (
        <SettingsCallout tone="warning" icon={<CircleAlert size={18} />}>
          {t('settings.testsNoStamp', { report: report.commit })}
        </SettingsCallout>
      )}
      {missing.length > 0 && (
        <SettingsCallout tone="danger" icon={<CircleAlert size={18} />}>
          {/* Two sentences, two entries. The count and the reason it matters
              are separate thoughts, and a language that puts the number last
              needs to be able to. */}
          <div className="testPane__banner">
            <span>
              {t('settings.testsSuitesMissing', {
                count: missing.length,
                n: formatNumber(missing.length),
              })}
            </span>
            <span>{t('settings.testsMissingWhy')}</span>
          </div>
        </SettingsCallout>
      )}
      {report.dirty && (
        <SettingsCallout tone="danger" icon={<CircleAlert size={18} />}>
          {t('settings.testsDirty', { commit: report.commit })}
        </SettingsCallout>
      )}

      <PaneSection
        title={t('settings.testsProvenance')}
        description={t('settings.testsProvenanceBody')}
      >
        <SettingRow id="test-version" label={t('settings.testsVersion')} value={report.version} />
        <SettingRow
          id="test-commit"
          label={t('settings.testsCommit')}
          hint={
            mine
              ? t('settings.testsThisBuildIs', { commit: mine })
              : t('settings.testsThisBuildUnstamped')
          }
          value={
            <Pill
              size="sm"
              variant="soft"
              tone={match === 'match' ? 'success' : match === 'mismatch' ? 'danger' : 'warning'}
            >
              {report.commit}
            </Pill>
          }
        />
        <SettingRow
          id="test-tree"
          label={t('settings.testsTree')}
          hint={t('settings.testsTreeHint')}
          value={report.dirty ? t('settings.testsTreeDirty') : t('settings.testsTreeClean')}
        />
        <SettingRow
          id="test-ran"
          label={t('settings.testsRan')}
          hint={Number.isFinite(ran) ? formatAgo(ran) : undefined}
          value={
            Number.isFinite(ran)
              ? formatDate(ran, { dateStyle: 'medium', timeStyle: 'short' })
              : report.generatedAt
          }
        />
        {/* Machine facts. No prose in "darwin arm64 v25.9.0" for anybody to
            translate, so it is joined rather than worded. */}
        <SettingRow
          id="test-host"
          label={t('settings.testsHost')}
          value={`${report.host.os} ${report.host.arch} · ${report.host.node}`}
        />
        {tools.length > 0 && (
          <SettingRow
            id="test-tools"
            label={t('settings.testsTools')}
            hint={t('settings.testsToolsHint')}
            layout="stacked"
            control={
              <div className="testPane__tools">
                {tools.map(([name, version]) => (
                  <Pill key={name} size="sm" variant="soft" tone="neutral">
                    {name} {version}
                  </Pill>
                ))}
              </div>
            }
          />
        )}
        {/* The ship guard's tally, as a fact rather than an alarm: a rewritten
            name is not a broken test, it is a test whose name could not be
            printed as written, and the number belongs with the rest of the
            provenance. */}
        {report.namesSanitised > 0 && (
          <SettingRow
            id="test-names-rewritten"
            label={t('settings.testsNamesRewritten')}
            hint={t('settings.testsNamesRewrittenHint')}
            value={
              <Pill size="sm" variant="soft" tone="warning">
                {formatNumber(report.namesSanitised)}
              </Pill>
            }
          />
        )}
        {/* The generator's own verdict, kept beside the one worked out above.
            They should agree; the interesting day is the one where they do
            not, and a pane that only showed ours would hide it. */}
        <SettingRow
          id="test-generator-verdict"
          label={t('settings.testsGeneratorSaid')}
          hint={report.ok === tally.ok ? undefined : t('settings.testsVerdictsDisagree')}
          value={
            <Pill size="sm" variant="soft" tone={report.ok ? 'success' : 'danger'}>
              {report.ok ? t('settings.testsStatusPassed') : t('settings.testsStatusFailed')}
            </Pill>
          }
        />
      </PaneSection>

      <PaneSection title={t('settings.testsFind')}>
        <SettingRow
          id="test-filter"
          label={t('settings.testsFilter')}
          hint={t('settings.testsFilterHint')}
          layout="stacked"
          control={
            <SearchField
              value={query}
              onValueChange={setQuery}
              placeholder={t('settings.testsFilterPlaceholder')}
              aria-label={t('settings.testsFilter')}
            />
          }
        />
        <SettingRow
          id="test-only-failures"
          label={t('settings.testsOnlyFailures')}
          hint={t('settings.testsOnlyFailuresHint')}
          control={
            <Switch
              checked={onlyFailures}
              onCheckedChange={setOnlyFailures}
              aria-label={t('settings.testsOnlyFailures')}
            />
          }
        />
        {filtering && (
          <SettingRow
            id="test-shown"
            label={t('settings.testsShowing')}
            value={formatNumber(totalShown)}
          />
        )}
      </PaneSection>

      {views.map((view) => {
        const suite = view.suite;
        const openSuite = isOpen(suite.id);
        return (
          <PaneSection
            key={suite.id}
            /* No caption: the row below IS this card's heading, and a
               small-caps caption above it only said the suite's name a second
               time. The row keeps the name because it is also the button's
               accessible name - a control that announces "1,358 of 1,359
               passed" and never says what of is a control read out of
               context. */
            footer={
              suite.command ? (
                <SettingsFootnote>
                  <span className="testPane__cmdLabel">{t('settings.testsCommand')}</span>
                  <code className="testPane__cmd">{suite.command}</code>
                </SettingsFootnote>
              ) : undefined
            }
          >
            <div className="testPane__group" data-open={openSuite || undefined}>
              <SettingRow
                id={`test-suite-${suite.id}`}
                icon={<FlaskConical size={16} />}
                label={suiteLabel(suite, t)}
                hint={t('settings.testsSuiteCounts', {
                  passed: formatNumber(suite.counts.passed),
                  total: formatNumber(suite.counts.total),
                  took: took(suite.durationMs),
                })}
                value={
                  <Pill size="sm" variant="soft" tone={suiteStatusTone(suite.status)}>
                    {suiteStatusWord(suite.status, t)}
                  </Pill>
                }
                onPress={() => toggle(suite.id)}
              />
            </div>

            {/* A suite with no result says WHY, always - open or closed. That
                sentence is the entire content of such a suite, and hiding it
                behind a chevron is hiding the only thing there is to read. */}
            {suiteDidNotRun(suite) && (
              <div className="testPane__reasonRow">
                <Text size="sm" weight="medium">
                  {t('settings.testsWhyNoResult')}
                </Text>
                <pre className="testPane__reason">
                  {suite.reason ?? t('settings.testsNoReason')}
                </pre>
                {suite.exitCode != null && (
                  <Text tone="muted" size="sm">
                    {t('settings.testsExitCode', { code: suite.exitCode })}
                  </Text>
                )}
              </div>
            )}

            {openSuite &&
              (view.files.length === 0 ? (
                /* A suite that never produced a result has already said why,
                   above; adding "it listed no tests" there is a second way of
                   saying the same absence. */
                suiteDidNotRun(suite) && !filtering ? null : (
                  <div className="testPane__empty">
                    <Text tone="muted" size="sm">
                      {filtering ? t('settings.testsNoMatches') : t('settings.testsNoCases')}
                    </Text>
                  </div>
                )
              ) : (
                view.files.map((group) => {
                  const key = groupKey(suite.id, group.file);
                  const openFile = isOpen(key);
                  return (
                    <div
                      key={group.file}
                      className="testPane__group testPane__group--file"
                      data-open={openFile || undefined}
                    >
                      <SettingRow
                        label={<span className="testPane__file">{group.file}</span>}
                        hint={t('settings.testsFileCases', {
                          count: group.tests.length,
                          n: formatNumber(group.tests.length),
                        })}
                        value={
                          group.failed > 0 ? (
                            <Pill size="sm" variant="soft" tone="danger">
                              {t('settings.testsSomeFailed', {
                                count: group.failed,
                                n: formatNumber(group.failed),
                              })}
                            </Pill>
                          ) : undefined
                        }
                        onPress={() => toggle(key)}
                        danger={group.failed > 0}
                      />
                      {openFile && (
                        <ul className="testPane__cases">
                          {group.tests.map((c, i) => (
                            <li
                              key={`${c.name}-${c.line ?? i}`}
                              className="testPane__case"
                              data-status={c.status}
                            >
                              <span className="testPane__caseGlyph" aria-hidden>
                                {c.status === 'passed' ? (
                                  <CircleCheck size={13} />
                                ) : c.status === 'failed' ? (
                                  <CircleX size={13} />
                                ) : (
                                  <MinusCircle size={13} />
                                )}
                              </span>
                              <span className="testPane__caseName">{c.name}</span>
                              <span className="testPane__caseMeta">
                                {c.line != null && (
                                  <span className="testPane__caseLine">
                                    {formatNumber(c.line)}
                                  </span>
                                )}
                                {c.ms != null ? (
                                  <span className="testPane__caseMs">{took(c.ms)}</span>
                                ) : (
                                  <span className="testPane__caseMs">
                                    {caseStatusWord(c.status, t)}
                                  </span>
                                )}
                              </span>
                              {c.failure && (
                                <pre className="testPane__failure">{c.failure}</pre>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })
              ))}
          </PaneSection>
        );
      })}

      {report.suites.length === 0 && (
        <SettingsCallout tone="danger" icon={<CircleAlert size={18} />}>
          {t('settings.testsNoSuites')}
        </SettingsCallout>
      )}
    </div>
  );
}
