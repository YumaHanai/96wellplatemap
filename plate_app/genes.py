"""Conservative label normalization and local human MANE v1.0 reference checks."""
import csv
import gzip
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CANONICAL = re.compile(r'^([A-Za-z0-9][A-Za-z0-9.\-]*)_In([1-9][0-9]*)$')
SEPARATORS = re.compile(r'^([A-Za-z0-9][A-Za-z0-9.\-]*?)[_\-\s]+[Ii][Nn]\s*0*([1-9][0-9]*)$')
UTR = re.compile(r'^([A-Za-z0-9][A-Za-z0-9.\-]*)_3UTR$')
STOCK = re.compile(r'^([A-Za-z0-9][A-Za-z0-9.\-]*)_(In[1-9][0-9]*|3UTR)_(Bulk|CLONE[1-9][0-9]*)$')


def normalize_stock(value):
    value = value.strip()
    match = re.fullmatch(r'([A-Za-z0-9][A-Za-z0-9.\-]*?)[_\-\s]+(In0*([1-9][0-9]*)|3UTR)[_\-\s]+(Bulk|CLONE0*([1-9][0-9]*))', value, re.I)
    if not match:
        return value
    locus = 'In'+match[3] if match[3] else '3UTR'
    clone = 'CLONE'+match[5] if match[5] else 'Bulk'
    return f'{match[1]}_{locus}_{clone}'


def approval_matches(item, loc, field, well):
    return (item.get('loc') == loc and item.get('field') == field and
            item.get('value') == well.get(field, '') and
            item.get('cell_type') == well.get('Cell_type', '') and
            item.get('gene') == well.get('Gene_intron', '') and
            item.get('stock') == well.get('Cell_Line_Stock', ''))


def normalize_gene(value):
    value = value.strip()
    match = SEPARATORS.fullmatch(value)
    return f'{match[1]}_In{match[2]}' if match else value


def control(value):
    return value.upper() == 'WT' or value.upper().endswith('_WT')


@lru_cache(maxsize=1)
def mane_reference():
    summary = ROOT / 'MANE.GRCh38.v1.0.summary.txt'
    gtf = ROOT / 'MANE.GRCh38.v1.0.refseq_genomic.gtf.gz'
    if not summary.exists():
        return {}, 'MANE reference file not found. Gene name checks were not performed.'
    genes = defaultdict(list)
    with summary.open() as stream:
        for row in csv.DictReader(stream, delimiter='\t'):
            genes[row['symbol']].append({'transcript': row['RefSeq_nuc'], 'status': row['MANE_status']})
    exons = defaultdict(set)
    if gtf.exists():
        with gzip.open(gtf, 'rt') as stream:
            for line in stream:
                if line.startswith('#'):
                    continue
                cols = line.rstrip().split('\t')
                if len(cols) != 9 or cols[2] != 'exon':
                    continue
                tid = re.search(r'transcript_id "([^"]+)"', cols[8])
                if tid:
                    exons[tid[1]].add((cols[0], cols[3], cols[4], cols[6]))
    for records in genes.values():
        for record in records:
            record['introns'] = max(0, len(exons[record['transcript']])-1) if record['transcript'] in exons else None
    return dict(genes), '' if gtf.exists() else 'GTF file unavailable. Intron number ranges have not been checked.'


def check_wells(wells, approvals=None, global_approvals=None):
    genes, reference_warning = mane_reference()
    issues, corrections, approved = [], [], []
    def add_issue(loc, field, value, message, well):
        if global_approvals is None:
            accepted = next((a for a in (approvals or []) if approval_matches(a, loc, field, well)), None)
        else:
            normalizer = normalize_gene if field == 'Gene_intron' else normalize_stock
            accepted = next((a for a in global_approvals if a['enabled'] and a['field'] == field and a['value'] == normalizer(value)), None)
        entry = {'loc': loc, 'field': field, 'value': value, 'message': message}
        if accepted:
            approved.append(dict(entry, approval=accepted))
        else:
            issues.append(entry)
    for loc, well in wells.items():
        raw = str(well.get('Gene_intron', '')).strip()
        normalized = normalize_gene(raw)
        if normalized != raw:
            corrections.append({'loc': loc, 'field': 'Gene_intron', 'before': raw, 'after': normalized})
        raw_stock = str(well.get('Cell_Line_Stock', '')).strip()
        stock = normalize_stock(raw_stock)
        if stock != raw_stock:
            corrections.append({'loc': loc, 'field': 'Cell_Line_Stock', 'before': raw_stock, 'after': stock})
        if stock not in ('', '-'):
            sm = STOCK.fullmatch(stock)
            reason = ''
            if not sm:
                reason = 'Expected Gene_InN_Bulk / CLONEN or Gene_3UTR_Bulk / CLONEN. Review and approve controls or custom labels if appropriate.'
            elif sm[1] not in genes:
                reason = 'The stock gene name is not in human MANE. Check the species and spelling.'
            elif (CANONICAL.fullmatch(normalized) or UTR.fullmatch(normalized)) and normalized != sm[1]+'_'+sm[2]:
                reason = 'The stock gene or target does not match the Gene intron field.'
            if reason:
                add_issue(loc, 'Cell_Line_Stock', raw_stock, reason, well)
        if normalized in ('', '-') or control(normalized):
            continue
        match = CANONICAL.fullmatch(normalized) or UTR.fullmatch(normalized)
        reason = ''
        if not match:
            reason = 'Cannot interpret as Gene_InN (for example PKM_In4). The original value has been kept.'
        elif not genes:
            reason = 'MANE reference is unavailable. Gene names and intron numbers have not been checked.'
        elif match[1] not in genes:
            reason = 'Gene not found in human MANE v1.0. Check spelling and species; this does not necessarily mean the label is incorrect.'
        elif not UTR.fullmatch(normalized):
            records = genes[match[1]]
            counts = [r['introns'] for r in records if r['introns'] is not None]
            if counts and (len(match[2]) > 9 or all(int(match[2]) > count for count in counts)):
                reason = 'Intron number exceeds the range of MANE reference transcripts. Check the transcript used.'
            elif not counts:
                reason = 'Gene name matched, but the intron count could not be retrieved.'
        if reason:
            add_issue(loc, 'Gene_intron', raw, reason, well)
    if global_approvals is not None:
        corrections = [c for c in corrections if not any(a['enabled'] and a['field'] == c['field'] and a['value'] == c['after'] for a in global_approvals)]
    return {'issues': issues, 'corrections': corrections, 'approved': approved, 'reference_warning': reference_warning,
            'reference': 'Human MANE GRCh38 v1.0. Intron numbers are checked only against exon counts minus one in reference transcripts. This does not identify the target intron or validate the experiment.'}


def plate_summary(wells):
    genes, stocks, conditions = set(), set(), set()
    ki_wells = 0
    for well in wells.values():
        gene = normalize_gene(str(well.get('Gene_intron', '')))
        match = CANONICAL.fullmatch(gene) or UTR.fullmatch(gene)
        stock = str(well.get('Cell_Line_Stock', '')).strip()
        if match:
            genes.add(match[1])
            if stock not in ('', '-') and not control(stock):
                stocks.add((str(well.get('Cell_type', '')).strip(), stock))
                ki_wells += 1
        condition = str(well.get('Conditions', '')).strip()
        if condition not in ('', '-'):
            conditions.add(condition)
    return {'genes': sorted(genes), 'ki_stocks': [list(s) for s in sorted(stocks)],
            'ki_wells': ki_wells, 'conditions': sorted(conditions)}
