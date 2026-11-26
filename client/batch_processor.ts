(function () {
    var picked: File[] = [];
    var drop = document.getElementById('drop') as HTMLDivElement;
    var picker = document.getElementById('picker') as HTMLInputElement;
    var filesBox = document.getElementById('files') as HTMLDivElement;
    var chips = document.getElementById('chips') as HTMLDivElement;
    var countEl = document.getElementById('count') as HTMLSpanElement;
    var go = document.getElementById('go') as HTMLButtonElement;
    var idleHint = document.getElementById('idleHint') as HTMLDivElement;
    var running = document.getElementById('running') as HTMLDivElement;
    var runCount = document.getElementById('runCount') as HTMLElement;
    var doneCount = document.getElementById('doneCount') as HTMLElement;
    var barFill = document.getElementById('barFill') as HTMLDivElement;
    var liveNote = document.getElementById('liveNote') as HTMLSpanElement;
    var timerEl = document.getElementById('timer') as HTMLElement;
    var errBox = document.getElementById('error') as HTMLDivElement;
    var summary = document.getElementById('summary') as HTMLDivElement;
    var results = document.getElementById('results') as HTMLDivElement;
    var rows = document.getElementById('rows') as HTMLTableSectionElement;
    var parallel = document.getElementById('parallel') as HTMLDivElement;
    var threadsNum = document.getElementById('threadsNum') as HTMLInputElement;
    var threadsRange = document.getElementById('threadsRange') as HTMLInputElement;
    var threadsNote = document.getElementById('threadsNote') as HTMLSpanElement;
    var dropTypes = document.getElementById('dropTypes') as HTMLDivElement;
    var folderPath = document.getElementById('folderPath') as HTMLInputElement;

    var cfg: any = {
        defaultWorkerThreads: 4,
        maxWorkerThreads: 8,
        maxCheques: 250,
        acceptedExtensions: [
            '.bmp',
            '.jpeg',
            '.jpg',
            '.pdf',
            '.png',
            '.tif',
            '.tiff'
        ]
    };

    var lastData: any = null;
    var sawDone = false;
    var received = 0;
    var expected = 0;

    render();

    fetch('/api/cheques/config')
        .then(function (r) {
            return r.ok ? r.json() : null;
        })
        .then(function (c) {
            if (c) {
                cfg = c;
            }
            applyConfig();
        })
        .catch(function () {
            applyConfig();
        });

    function applyConfig() {
        threadsRange.max = String(cfg.maxWorkerThreads);
        threadsNum.max = String(cfg.maxWorkerThreads);
        setThreads(cfg.defaultWorkerThreads);
        picker.setAttribute('accept', cfg.acceptedExtensions.join(','));
        dropTypes.textContent =
            'Multiple files at once · ' + cfg.acceptedExtensions.join(' ');
    }

    function setThreads(value: any) {
        var n = Math.round(Number(value));

        if (!isFinite(n)) {
            n = cfg.defaultWorkerThreads;
        }

        n = Math.max(1, Math.min(n, cfg.maxWorkerThreads));

        threadsNum.value = String(n);
        threadsRange.value = String(n);
        threadsNote.textContent =
            n + ' cheques processed simultaneously.';

        return n;
    }

    folderPath.addEventListener('input', render);

    threadsRange.addEventListener('input', function () {
        setThreads(threadsRange.value);
    });

    threadsNum.addEventListener('input', function () {
        threadsRange.value = threadsNum.value;
    });

    threadsNum.addEventListener('change', function () {
        setThreads(threadsNum.value);
    });

    drop.addEventListener('click', function () {
        picker.click();
    });

    picker.addEventListener('change', function () {
        add(picker.files as FileList);
        picker.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (e) {
        drop.addEventListener(e, function (ev) {
            ev.preventDefault();
            drop.classList.add('over');
        });
    });

    ['dragleave', 'drop'].forEach(function (e) {
        drop.addEventListener(e, function (ev) {
            ev.preventDefault();
            drop.classList.remove('over');
        });
    });

    drop.addEventListener('drop', function (ev: DragEvent) {
        add(ev.dataTransfer!.files);
    });

    document.getElementById('clear')!.addEventListener('click', function () {
        picked = [];
        render();
    });

    function add(list: FileList) {
        for (var i = 0; i < list.length; i++) {
            var f = list[i];
            var ext = f.name
                .slice(f.name.lastIndexOf('.'))
                .toLowerCase();

            if (cfg.acceptedExtensions.indexOf(ext) !== -1) {
                if (
                    !picked.some(function (p) {
                        return p.name === f.name && p.size === f.size;
                    })
                ) {
                    picked.push(f);
                }
            }
        }

        render();
    }

    function render() {
        var folder = folderPath.value.trim();

        filesBox.style.display = picked.length ? 'block' : 'none';

        go.disabled = picked.length === 0 && !folder;

        idleHint.textContent = picked.length
            ? picked.length + ' file(s) ready.'
            : folder
                ? 'Will read from ' + folder
                : 'Select files or type folder path.';

        countEl.textContent =
            picked.length + ' file(s) selected';

        chips.innerHTML = '';

        picked.forEach(function (f, i) {
            var chip = document.createElement('span');

            chip.className = 'chip';
            chip.textContent = f.name + ' ';

            var btn = document.createElement('button');

            btn.textContent = '×';

            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                picked.splice(i, 1);
                render();
            });

            chip.appendChild(btn);
            chips.appendChild(chip);
        });
    }

    go.addEventListener('click', function () {
        var folder = folderPath.value.trim();

        if (!picked.length && !folder) {
            return;
        }

        var threads = setThreads(threadsNum.value);

        var form = new FormData();

        picked.forEach(function (f) {
            form.append('files', f);
        });

        if (folder) {
            form.append('folderPath', folder);
        }

        form.append('workerThreads', String(threads));

        errBox.style.display = 'none';

        rows.innerHTML = '';

        lastData = null;
        sawDone = false;
        received = 0;
        expected = picked.length;

        setSummary(null);

        summary.style.display = 'block';
        results.style.display = 'block';

        go.disabled = true;
        running.style.display = 'flex';

        runCount.textContent = String(picked.length || '…');
        doneCount.textContent = '0';
        barFill.style.width = '0%';
        liveNote.textContent = 'receiving…';

        var t0 = Date.now();

        var tick = setInterval(function () {
            timerEl.textContent =
                ((Date.now() - t0) / 1000).toFixed(1) + 's';
        }, 100);

        fetch('/api/cheques/process/stream', {
            method: 'POST',
            body: form
        })
            .then(function (res) {
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }

                return readStream(res.body!.getReader());
            })
            .catch(function (e) {
                errBox.textContent = e.message;
                errBox.style.display = 'block';
            })
            .then(function () {
                clearInterval(tick);

                running.style.display = 'none';
                go.disabled = false;

                picked = [];

                render();
            });
    });

    function readStream(
        reader: ReadableStreamDefaultReader<Uint8Array>
    ): Promise<void> {
        var decoder = new TextDecoder();
        var buffer = '';

        return reader.read().then(function step(chunk): any {
            if (chunk.done) {
                if (buffer.trim()) {
                    handle(JSON.parse(buffer));
                }

                return;
            }

            buffer += decoder.decode(chunk.value, {
                stream: true
            });

            var lines = buffer.split('\n');

            buffer = lines.pop() as string;

            lines.forEach(function (line) {
                if (line.trim()) {
                    handle(JSON.parse(line));
                }
            });

            return reader.read().then(step);
        });
    }

    function handle(evt: any) {
        if (evt.type === 'batch') {
            lastData = {
                batchId: evt.batchId,
                status: 'PROCESSING',
                totalFiles: evt.totalFiles,
                totalCheques: evt.totalCheques,
                processedCount: 0,
                failedCount: 0,
                results: []
            };

            expected = evt.totalCheques;

            runCount.textContent = String(evt.totalCheques);

            setSummary(lastData);
        } else if (evt.type === 'cheque') {
            lastData.results.push(evt.result);

            if (evt.result.status === 'PROCESSED') {
                lastData.processedCount++;
            } else {
                lastData.failedCount++;
            }

            doneCount.textContent = String(evt.done);

            barFill.style.width =
                (evt.done / evt.total * 100) + '%';

            addRow(evt.result);

            setSummary(lastData);
        } else if (evt.type === 'done') {
            lastData.status = evt.status;
            lastData.processedCount = evt.processedCount;
            lastData.failedCount = evt.failedCount;
            lastData.processingTimeSeconds =
                evt.processingTimeSeconds;
            lastData.throughputChequesPerSec =
                evt.throughputChequesPerSec;

            setSummary(lastData);
        }
    }

    function setSummary(d: any) {
        document.getElementById('sTotal')!.textContent =
            d ? String(d.totalCheques) : '—';

        document.getElementById('sOk')!.textContent =
            d ? String(d.processedCount) : '—';

        document.getElementById('sFail')!.textContent =
            d ? String(d.failedCount) : '—';

        document.getElementById('sPending')!.textContent =
            d
                ? String(
                    Math.max(
                        d.totalCheques -
                        d.processedCount -
                        d.failedCount,
                        0
                    )
                )
                : '—';

        document.getElementById('sTime')!.textContent =
            d && d.processingTimeSeconds != null
                ? d.processingTimeSeconds + 's'
                : '—';

        document.getElementById('sRate')!.textContent =
            d && d.throughputChequesPerSec != null
                ? d.throughputChequesPerSec + '/s'
                : '—';
    }

    function addRow(r: any) {
        var tr = document.createElement('tr');

        tr.appendChild(
            td(r.fileName, 'name')
        );

        tr.appendChild(
            td(
                r.accountNumber
                    ? r.accountNumber.value
                    : null,
                'mono'
            )
        );

        tr.appendChild(
            conf(r.accountNumber)
        );

        tr.appendChild(
            td(
                r.accountHolderName
                    ? r.accountHolderName.value
                    : null,
                ''
            )
        );

        tr.appendChild(
            conf(r.accountHolderName)
        );

        tr.appendChild(
            td(
                r.ocrDurationMs == null
                    ? '—'
                    : (r.ocrDurationMs / 1000).toFixed(2) + 's',
                'num'
            )
        );

        var tdSt = document.createElement('td');

        var ok = r.status === 'PROCESSED';

        tdSt.innerHTML =
            '<span class="badge ' +
            (ok ? 'ok' : 'bad') +
            '">' +
            (ok ? 'Processed' : 'Failed') +
            '</span>';

        tr.appendChild(tdSt);

        rows.appendChild(tr);
    }

    function td(
        text: string | null | undefined,
        cls: string
    ) {
        var c = document.createElement('td');

        if (cls) {
            c.className = cls;
        }

        c.textContent = text || 'not found';

        return c;
    }

    function conf(field: any) {
        var c = document.createElement('td');

        c.className = 'num';

        var pct = field
            ? field.confidencePercent
            : null;

        var span = document.createElement('span');

        span.className =
            'conf ' +
            (pct >= 80
                ? 'g'
                : pct >= 50
                    ? 'm'
                    : 'l');

        span.textContent =
            pct != null
                ? pct.toFixed(1) + '%'
                : '—';

        c.appendChild(span);

        return c;
    }

    document
        .getElementById('viewJson')!
        .addEventListener('click', function () {
            if (!lastData) {
                return;
            }

            document.getElementById('jsonOut')!.textContent =
                JSON.stringify(lastData, null, 2);

            document
                .getElementById('modal')!
                .classList.add('open');
        });

    document
        .getElementById('closeModal')!
        .addEventListener('click', function () {
            document
                .getElementById('modal')!
                .classList.remove('open');
        });
})();