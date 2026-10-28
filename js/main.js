/* ============================================================
   Smart Parking Manager — Application Logic
   Wires the parking data module to the UI and handles
   persistence.
   ============================================================ */

(function () {
  'use strict';

  // ---- State ----
  let slots = createSlotArray();            // Array of 20 slot objects
  let waitingQueue = createQueue();         // FIFO queue of vehicles
  let historyList = createLinkedList();     // Linked list of completed sessions
  let vehicleTable = createVehicleHashTable(); // Map: reg → { slotIndex, vehicle }
  let sessionCounter = 0;                   // monotonic session id
  let receiptCounter = 0;                   // monotonic receipt number
  let lastReceipt = null;                   // last generated receipt (persisted)
  let currentExitContext = null;            // { reg, slotIndex, vehicle }

  const VEHICLE_TYPES = ['Bike', 'Car', 'Other'];

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    // stats
    statTotal: $('#stat-total'),
    statAvailable: $('#stat-available'),
    statOccupied: $('#stat-occupied'),
    statQueue: $('#stat-queue'),
    gridStatus: $('#grid-status'),
    parkingGrid: $('#parking-grid'),
    // nav
    sidebar: $('#sidebar'),
    mobileToggle: $('#mobile-toggle'),
    navItems: $$('.nav-item'),
    sections: {
      dashboard: $('#sec-dashboard'),
      parkingMap: $('#sec-parking-map'),
      parkingGrid: $('#sec-parking-grid'),
      entry: $('#sec-entry'),
      search: $('#sec-search'),
      exit: $('#sec-exit'),
      history: $('#sec-history'),
      receipt: $('#sec-receipt'),
    },
    topbarTitle: $('#topbar-title'),
    topbarBadge: $('#topbar-badge'),
    // parking map
    mapGrid: $('#map-grid'),
    mapStatus: $('#map-status'),
    slotDetails: $('#slot-details'),
    slotDetailsTitle: $('#slot-details-title'),
    slotDetailsStatus: $('#slot-details-status'),
    slotDetId: $('#slot-det-id'),
    slotDetStatus: $('#slot-det-status'),
    slotDetReg: $('#slot-det-reg'),
    slotDetType: $('#slot-det-type'),
    slotDetEntry: $('#slot-det-entry'),
    slotDetRegRow: $('#slot-det-reg-row'),
    slotDetTypeRow: $('#slot-det-type-row'),
    slotDetEntryRow: $('#slot-det-entry-row'),
    slotDetLiveDurationRow: $('#slot-det-live-duration-row'),
    slotDetLiveFeeRow: $('#slot-det-live-fee-row'),
    slotDetLiveDuration: $('#slot-det-live-duration'),
    slotDetLiveFee: $('#slot-det-live-fee'),
    slotDetailsClose: $('#slot-details-close'),
    // search
    searchReg: $('#search-reg'),
    searchType: $('#search-type'),
    searchSort: $('#search-sort'),
    searchCount: $('#search-count'),
    searchResultsGrid: $('#search-results-grid'),
    searchEmpty: $('#search-empty'),
    // queue
    queueSection: $('#queue-section'),
    queueList: $('#queue-list'),
    queueEmpty: $('#queue-empty'),
    // entry
    entryForm: $('#entry-form'),
    entryReg: $('#entry-reg'),
    entryType: $('#entry-type'),
    entryFeedback: $('#entry-feedback'),
    // exit
    exitForm: $('#exit-form'),
    exitReg: $('#exit-reg'),
    btnSearchExit: $('#btn-search-exit'),
    exitResult: $('#exit-result'),
    exitRegDisplay: $('#exit-reg-display'),
    exitTypeDisplay: $('#exit-type-display'),
    exitSlotDisplay: $('#exit-slot-display'),
    exitEntryDisplay: $('#exit-entry-display'),
    exitExitDisplay: $('#exit-exit-display'),
    exitDurationDisplay: $('#exit-duration-display'),
    exitFeeDisplay: $('#exit-fee-display'),
    btnExitConfirm: $('#btn-exit-confirm'),
    btnExitCancel: $('#btn-exit-cancel'),
    exitFeedback: $('#exit-feedback'),
    // history
    historySearch: $('#history-search'),
    sortSelect: $('#sort-select'),
    historyTbody: $('#history-tbody'),
    historyEmpty: $('#history-empty'),
    btnReset: $('#btn-reset'),
    // receipt
    receiptSection: $('#receipt-section'),
    receiptNumber: $('#receipt-number'),
    receiptReg: $('#receipt-reg'),
    receiptType: $('#receipt-type'),
    receiptSlot: $('#receipt-slot'),
    receiptEntryTime: $('#receipt-entry-time'),
    receiptExitTime: $('#receipt-exit-time'),
    receiptDuration: $('#receipt-duration'),
    receiptDurationLong: $('#receipt-duration-long'),
    receiptFeeItemized: $('#receipt-fee-itemized'),
    receiptTotal: $('#receipt-total'),
    receiptDate: $('#receipt-date'),
    receiptEmpty: $('#receipt-empty'),
    receiptActions: $('.receipt-actions'),
    btnPrintReceipt: $('#btn-print-receipt'),
    btnReceiptClose: $('#btn-receipt-close'),
    // toast
    toastContainer: $('#toast-container'),
  };

  // ---- Storage keys ----
  const STORAGE_KEY = 'smartParkingState';

  // ============================================================
  // PERSISTENCE
  // ============================================================
  function saveState() {
    const state = {
      slots: cloneSlots(slots),
      waitingQueue: waitingQueue.toArray(),
      historyList: historyList.toArray(),
      vehicleTable: vehicleTable.toObject(),
      sessionCounter: sessionCounter,
      receiptCounter: receiptCounter,
      lastReceipt: lastReceipt,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('LocalStorage save failed:', e);
    }
  }

  function normalizeVehicleRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const reg = normalizeReg(record.reg);
    const type = VEHICLE_TYPES.indexOf(record.type) !== -1 ? record.type : null;
    const entryTime = Number(record.entryTime);
    if (!isValidReg(reg) || !type || !Number.isFinite(entryTime) || entryTime <= 0) {
      return null;
    }
    return { reg: reg, type: type, entryTime: entryTime };
  }

  function normalizeSessionRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const reg = normalizeReg(record.reg);
    const type = VEHICLE_TYPES.indexOf(record.type) !== -1 ? record.type : 'Other';
    const entryTime = Number(record.entryTime);
    const exitTime = Number(record.exitTime);
    const duration = Number(record.duration);
    const fee = Number(record.fee);
    if (!isValidReg(reg) || !Number.isFinite(entryTime) || !Number.isFinite(exitTime) || exitTime < entryTime) {
      return null;
    }
    return {
      id: Number(record.id) || 0,
      reg: reg,
      type: type,
      slot: /^P\d{2}$/.test(String(record.slot || '')) ? String(record.slot) : '—',
      entryTime: entryTime,
      exitTime: exitTime,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : (exitTime - entryTime) / 1000,
      fee: Number.isFinite(fee) && fee >= 0 ? fee : 0,
      receiptNumber: typeof record.receiptNumber === 'string' ? record.receiptNumber : '',
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw);
      if (!state || !Array.isArray(state.slots) || state.slots.length !== TOTAL_SLOTS) {
        localStorage.removeItem(STORAGE_KEY);
        return false;
      }

      // Rebuild the slot array from validated records.
      const restoredSlots = createSlotArray();
      for (let i = 0; i < state.slots.length; i++) {
        const savedSlot = state.slots[i];
        if (!savedSlot || typeof savedSlot !== 'object') {
          localStorage.removeItem(STORAGE_KEY);
          return false;
        }
        if (!savedSlot.occupied || !savedSlot.vehicle) continue;
        const vehicle = normalizeVehicleRecord(savedSlot.vehicle);
        if (!vehicle) {
          localStorage.removeItem(STORAGE_KEY);
          return false;
        }
        restoredSlots[i].occupied = true;
        restoredSlots[i].vehicle = vehicle;
      }

      // Rebuild the lookup table from the slots. This guarantees that search,
      // exit and duplicate checks can never disagree with the rendered map.
      const restoredTable = createVehicleHashTable();
      for (let i = 0; i < restoredSlots.length; i++) {
        const slot = restoredSlots[i];
        if (!slot.occupied) continue;
        if (restoredTable.has(slot.vehicle.reg)) {
          // Drop duplicate slot records rather than leaving two slots for one car.
          slot.occupied = false;
          slot.vehicle = null;
          continue;
        }
        restoredTable.put(slot.vehicle.reg, i, slot.vehicle);
      }

      // Restore the queue in strict FIFO order, skipping invalid/duplicate entries.
      const restoredQueue = createQueue();
      const queuedRegs = new Set();
      if (Array.isArray(state.waitingQueue)) {
        for (let i = 0; i < state.waitingQueue.length; i++) {
          const queued = normalizeVehicleRecord(state.waitingQueue[i]);
          if (!queued || restoredTable.has(queued.reg) || queuedRegs.has(queued.reg)) continue;
          queuedRegs.add(queued.reg);
          restoredQueue.enqueue(queued);
        }
      }

      // Restore completed sessions and derive safe counters from them.
      const restoredHistory = createLinkedList();
      const usedSessionIds = new Set();
      let maxSessionId = 0;
      let maxReceiptNumber = 0;
      const savedHistory = Array.isArray(state.historyList) ? state.historyList : [];
      for (let i = 0; i < savedHistory.length; i++) {
        const session = normalizeSessionRecord(savedHistory[i]);
        if (!session) continue;
        if (!session.id || usedSessionIds.has(session.id)) {
          session.id = maxSessionId + 1;
        }
        usedSessionIds.add(session.id);
        maxSessionId = Math.max(maxSessionId, session.id);
        const match = /^SPM-(\d+)$/.exec(session.receiptNumber);
        if (match) maxReceiptNumber = Math.max(maxReceiptNumber, Number(match[1]));
        restoredHistory.push(session);
      }

      slots = restoredSlots;
      waitingQueue = restoredQueue;
      historyList = restoredHistory;
      vehicleTable = restoredTable;
      sessionCounter = Math.max(Number(state.sessionCounter) || 0, maxSessionId);
      receiptCounter = Math.max(Number(state.receiptCounter) || 0, maxReceiptNumber);
      lastReceipt = normalizeReceipt(state.lastReceipt);
      if (!lastReceipt && historyList.length > 0) {
        const sessions = historyList.toArray();
        let latest = sessions[0];
        for (let i = 1; i < sessions.length; i++) {
          if (sessions[i].exitTime > latest.exitTime) latest = sessions[i];
        }
        lastReceipt = receiptFromSession(latest);
      }
      return true;
    } catch (e) {
      console.warn('LocalStorage load failed:', e);
      return false;
    }
  }

  function resetState() {
    if (!confirm('Reset all parking data? This cannot be undone.')) return;
    slots = createSlotArray();
    waitingQueue = createQueue();
    historyList = createLinkedList();
    vehicleTable = createVehicleHashTable();
    sessionCounter = 0;
    receiptCounter = 0;
    lastReceipt = null;
    currentExitContext = null;
    localStorage.removeItem(STORAGE_KEY);

    // Clear transient form/result state as well as persisted data.
    dom.entryReg.value = '';
    dom.exitReg.value = '';
    dom.exitResult.style.display = 'none';
    dom.searchReg.value = '';
    dom.searchType.value = '';
    dom.searchSort.value = 'entry-desc';
    dom.historySearch.value = '';
    dom.sortSelect.value = 'entry';
    hideEntryFeedback();
    hideExitFeedback();
    closeSlotDetails();
    renderAll();
    goTo('dashboard');
    renderReceipt(null);
    toast('All data has been reset.', 'info');
  }

  // ============================================================
  // FEE CALCULATION — Flat rate pricing
  // ============================================================
  /**
   * Calculate duration in seconds and parking fee in INR (₹).
   *
   * Rate policy (transparent, vehicle-type-independent):
   *  - First hour (or part thereof): ₹30
   *  - Every additional hour or part thereof: ₹20
   *  - Examples:
   *      30 minutes  → ₹30  (first hour cover)
   *      1h 10min    → ₹50  (₹30 first hour + ₹20 next part-hour)
   *      2h 5min     → ₹70  (₹30 first hour + ₹20 + ₹20)
   *  - Duration must be non-negative; negative or zero duration yields ₹0.
   *
   * @param {number} entryTime - Entry timestamp (ms)
   * @param {number} exitTime  - Exit timestamp (ms)
   * @returns {{ durationMs: number, durationSec: number, fee: number }}
   */
  function calcFee(entryTime, exitTime) {
    // Guard against invalid timestamps
    if (!entryTime || !exitTime || exitTime < entryTime) {
      return { durationMs: 0, durationSec: 0, fee: 0 };
    }
    const durationMs = exitTime - entryTime;
    const durationSec = durationMs / 1000;
    if (durationSec <= 0) {
      return { durationMs: 0, durationSec: 0, fee: 0 };
    }
    const hoursRaw = durationSec / 3600;
    let fee;
    if (hoursRaw <= 1) {
      // Within the first hour (or exactly one hour)
      fee = 30;
    } else {
      // First hour: ₹30, then ₹20 for each additional started hour
      const additionalHours = Math.ceil(hoursRaw - 1);
      fee = 30 + additionalHours * 20;
    }
    return { durationMs, durationSec, fee };
  }

  function formatDuration(sec) {
    const totalSec = Math.max(0, Math.round(sec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts = [];
    if (h > 0) parts.push(h + 'h');
    if (m > 0) parts.push(m + 'm');
    parts.push(s + 's');
    return parts.join(' ');
  }

  /** Format duration as HH:MM:SS for receipts and tables. */
  function formatDurationHM(sec) {
    const totalSec = Math.max(0, Math.round(sec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map(function (v) { return String(v).padStart(2, '0'); }).join(':');
  }

  /** Format a timestamp for display. */
  function formatTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  /** Format a timestamp for the printable receipt (full date + time). */
  function formatReceiptTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-IN', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatCurrency(amount) {
    return '₹' + amount.toFixed(0);
  }

  // ============================================================
  // VALIDATION
  // ============================================================
  function normalizeReg(reg) {
    return String(reg == null ? '' : reg)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ');
  }

  function isValidReg(reg) {
    if (!reg) return false;
    const cleaned = normalizeReg(reg);
    // 4-12 characters (letters, digits, hyphen, single spaces) with at
    // least one letter/digit so that whitespace-only values are rejected.
    return /^(?=.*[A-Z0-9])[A-Z0-9 -]{4,12}$/.test(cleaned);
  }

  // ============================================================
  // VEHICLE ENTRY
  // ============================================================
  function handleEntry(reg, type) {
    const cleaned = normalizeReg(reg);
    if (!isValidReg(cleaned)) {
      showEntryFeedback('Invalid registration number. Use 4–12 alphanumeric characters (hyphen and space allowed).', 'error');
      return;
    }
    if (VEHICLE_TYPES.indexOf(type) === -1) {
      showEntryFeedback('Please select a valid vehicle type.', 'error');
      return;
    }
    const parked = vehicleTable.get(cleaned);
    if (parked) {
      const parkedSlot = slots[parked.slotIndex] ? slots[parked.slotIndex].id : 'a slot';
      showEntryFeedback('This registration is already parked at ' + parkedSlot + '.', 'error');
      return;
    }
    // Check the waiting queue for duplicate registrations too
    const queueItems = waitingQueue.toArray();
    for (let i = 0; i < queueItems.length; i++) {
      if (queueItems[i].reg === cleaned) {
        showEntryFeedback('This registration is already in the waiting queue (position ' + (i + 1) + ').', 'error');
        return;
      }
    }

    // Try to assign the first free slot
    const slotIndex = findFirstAvailableSlot(slots);
    const entryTime = Date.now();
    const vehicle = { reg: cleaned, type: type, entryTime: entryTime };

    if (slotIndex === -1) {
      // Lot full: enqueue
      waitingQueue.enqueue({ reg: cleaned, type: type, entryTime: entryTime });
      saveState();
      renderAll();
      dom.entryReg.value = '';
      showEntryFeedback('All slots are occupied. ' + cleaned + ' has been added to the waiting queue (position ' + waitingQueue.size + ').', 'info');
      toast('Lot full — ' + cleaned + ' joined the queue.', 'info');
      return;
    }

    // Occupy slot
    occupySlot(slots, slotIndex, vehicle);
    vehicleTable.put(cleaned, slotIndex, vehicle);
    saveState();
    renderAll();
    dom.entryReg.value = '';
    showEntryFeedback('Parked ' + cleaned + ' at ' + slots[slotIndex].id + ' successfully.', 'success');
    toast('Parked ' + cleaned + ' at ' + slots[slotIndex].id, 'success');
  }

  // ============================================================
  // VEHICLE EXIT
  // ============================================================
  function clearExitResult() {
    dom.exitResult.style.display = 'none';
    currentExitContext = null;
  }

  function searchExitVehicle(reg) {
    const cleaned = normalizeReg(reg);
    if (!isValidReg(cleaned)) {
      clearExitResult();
      showExitFeedback('Invalid registration number.', 'error');
      return;
    }
    const found = vehicleTable.get(cleaned);
    if (!found) {
      clearExitResult();
      const queued = waitingQueue.toArray();
      for (let i = 0; i < queued.length; i++) {
        if (queued[i].reg === cleaned) {
          showExitFeedback(cleaned + ' is in the waiting queue (position ' + (i + 1) + ') and has no active slot yet.', 'info');
          return;
        }
      }
      showExitFeedback('No active vehicle found with registration ' + cleaned + '.', 'error');
      return;
    }
    if (!slots[found.slotIndex] || !slots[found.slotIndex].occupied) {
      clearExitResult();
      showExitFeedback('The parking record for ' + cleaned + ' is out of date. Please try again.', 'error');
      return;
    }

    currentExitContext = { reg: cleaned, slotIndex: found.slotIndex, vehicle: found.vehicle };
    const v = found.vehicle;
    const now = Date.now();
    const calc = calcFee(v.entryTime, now);
    const duration = calc.durationSec;

    dom.exitRegDisplay.textContent = v.reg;
    dom.exitTypeDisplay.textContent = v.type;
    dom.exitSlotDisplay.textContent = slots[found.slotIndex].id;
    dom.exitEntryDisplay.textContent = formatTime(v.entryTime);
    dom.exitExitDisplay.textContent = formatTime(now);
    dom.exitDurationDisplay.textContent = formatDuration(duration);
    // Show itemized estimated fee, matching calcFee logic
    const breakdown = getFeeBreakdown(duration, calc.fee);
    if (calc.fee === 0) {
      dom.exitFeeDisplay.textContent = 'Free (no charge)';
    } else {
      const parts = ['First hour: ' + formatCurrency(breakdown.firstHour)];
      if (breakdown.additionalHours > 0) {
        parts.push(breakdown.additionalHours + ' additional hour' + (breakdown.additionalHours > 1 ? 's' : '') + ': ' + formatCurrency(breakdown.additionalFee));
      }
      parts.push('Estimated total: ' + formatCurrency(calc.fee));
      dom.exitFeeDisplay.innerHTML = parts.join('<br>');
    }

    dom.exitResult.style.display = 'block';
    hideExitFeedback();
  }

  function confirmExit() {
    if (!currentExitContext) return;
    const { reg, slotIndex } = currentExitContext;
    const active = vehicleTable.get(reg);
    if (!active || active.slotIndex !== slotIndex || !slots[slotIndex] || !slots[slotIndex].occupied) {
      clearExitResult();
      renderAll();
      showExitFeedback('This vehicle is no longer parked, so the exit could not be processed.', 'error');
      return;
    }

    // Capture and clear the context before mutating state. This makes the
    // confirmation handler re-entrancy safe: a double click cannot create a
    // second history row or a duplicate receipt.
    const vehicle = active.vehicle;
    currentExitContext = null;
    const now = Date.now();
    const calc = calcFee(vehicle.entryTime, now);
    const durationSec = calc.durationSec;
    const fee = calc.fee;
    const slotId = slots[slotIndex].id;
    const receiptNumber = 'SPM-' + String(receiptCounter + 1).padStart(4, '0');
    const sessionId = sessionCounter + 1;

    // Remove the active record and free the slot.
    vehicleTable.remove(reg);
    const releasedVehicle = vacateSlot(slots, slotIndex);
    if (!releasedVehicle) {
      // Restore the lookup entry if the slot was unexpectedly empty.
      vehicleTable.put(reg, slotIndex, vehicle);
      renderAll();
      showExitFeedback('Unable to release the slot. Please refresh and try again.', 'error');
      return;
    }

    receiptCounter += 1;
    sessionCounter += 1;

    const receipt = makeReceipt({
      receiptNumber: receiptNumber,
      sessionId: sessionId,
      reg: releasedVehicle.reg,
      type: releasedVehicle.type,
      slot: slotId,
      entryTime: releasedVehicle.entryTime,
      exitTime: now,
      durationSec: durationSec,
      fee: fee,
    });
    lastReceipt = receipt;

    // Create history node (linked list)
    const session = {
      id: sessionId,
      reg: releasedVehicle.reg,
      type: releasedVehicle.type,
      slot: slotId,
      entryTime: releasedVehicle.entryTime,
      exitTime: now,
      duration: durationSec,
      fee: fee,
      receiptNumber: receiptNumber,
    };
    historyList.push(session);

    // Assign the just-released slot to the first vehicle in the FIFO queue.
    let autoMessage = '';
    while (!waitingQueue.isEmpty()) {
      const next = waitingQueue.dequeue();
      if (!next || !isValidReg(next.reg) || vehicleTable.has(next.reg)) continue;
      const nextVehicle = { reg: next.reg, type: next.type, entryTime: next.entryTime };
      occupySlot(slots, slotIndex, nextVehicle);
      vehicleTable.put(next.reg, slotIndex, nextVehicle);
      autoMessage = ' ' + next.reg + ' (from queue) was assigned to ' + slotId + '.';
      break;
    }

    saveState();
    renderAll();
    dom.exitResult.style.display = 'none';
    showReceipt(receipt);

    let msg = 'Exit recorded for ' + reg + '. Duration: ' + formatDuration(durationSec) + '. Fee: ';
    msg += fee === 0 ? 'Free' : formatCurrency(fee);
    if (autoMessage) msg += autoMessage;
    showExitFeedback(msg, 'success');
    toast('Exit recorded: ' + reg + ' — Receipt ' + receiptNumber, 'success');
  }

  function cancelExit() {
    dom.exitResult.style.display = 'none';
    currentExitContext = null;
    hideExitFeedback();
    dom.exitReg.value = '';
  }

  // ============================================================
  // PRINTABLE RECEIPT
  // ============================================================
  function getFeeBreakdown(durationSec, fee) {
    const safeDuration = Math.max(0, Number(durationSec) || 0);
    const safeFee = Math.max(0, Number(fee) || 0);
    const firstHour = safeFee > 0 ? Math.min(safeFee, 30) : 0;
    const additionalHours = safeDuration > 3600 ? Math.ceil(safeDuration / 3600 - 1) : 0;
    return {
      firstHour: firstHour,
      additionalHours: additionalHours,
      additionalFee: safeFee > 0 ? additionalHours * 20 : 0,
    };
  }

  function makeReceipt(data) {
    const durationSec = Math.max(0, Number(data.durationSec) || 0);
    const fee = Math.max(0, Number(data.fee) || 0);
    const breakdown = getFeeBreakdown(durationSec, fee);
    return {
      receiptNumber: String(data.receiptNumber || 'SPM-0000'),
      sessionId: Number(data.sessionId) || 0,
      reg: normalizeReg(data.reg),
      type: VEHICLE_TYPES.indexOf(data.type) !== -1 ? data.type : 'Other',
      slot: /^P\d{2}$/.test(String(data.slot || '')) ? String(data.slot) : '—',
      entryTime: Number(data.entryTime) || 0,
      exitTime: Number(data.exitTime) || 0,
      durationSec: durationSec,
      fee: fee,
      entryFeeDesc: fee > 0 ? 'First hour' : 'No charge',
      entryFeeAmt: breakdown.firstHour,
      additionalHours: breakdown.additionalHours,
      additionalFeeDesc: breakdown.additionalHours > 0
        ? breakdown.additionalHours + ' additional hour' + (breakdown.additionalHours > 1 ? 's' : '') + ' × ₹20.00'
        : '',
      additionalFeeAmt: breakdown.additionalFee,
      finalFee: fee,
    };
  }

  function receiptFromSession(session) {
    if (!session) return null;
    return makeReceipt({
      receiptNumber: session.receiptNumber || ('SPM-' + String(session.id || 0).padStart(4, '0')),
      sessionId: session.id,
      reg: session.reg,
      type: session.type,
      slot: session.slot,
      entryTime: session.entryTime,
      exitTime: session.exitTime,
      durationSec: session.duration,
      fee: session.fee,
    });
  }

  function normalizeReceipt(record) {
    if (!record || typeof record !== 'object') return null;
    const reg = normalizeReg(record.reg);
    const entryTime = Number(record.entryTime);
    const exitTime = Number(record.exitTime);
    const durationSec = Number(record.durationSec);
    const fee = Number(record.fee);
    if (!isValidReg(reg) || !Number.isFinite(entryTime) || !Number.isFinite(exitTime) || exitTime < entryTime) {
      return null;
    }
    if (!Number.isFinite(durationSec) || durationSec < 0 || !Number.isFinite(fee) || fee < 0) {
      return null;
    }
    return makeReceipt({
      receiptNumber: record.receiptNumber || ('SPM-' + String(record.sessionId || 0).padStart(4, '0')),
      sessionId: record.sessionId,
      reg: reg,
      type: record.type,
      slot: record.slot,
      entryTime: entryTime,
      exitTime: exitTime,
      durationSec: durationSec,
      fee: fee,
    });
  }

  function renderReceipt(receipt) {
    if (!dom.receiptSection) return;
    if (!receipt) {
      dom.receiptSection.style.display = 'none';
      if (dom.receiptEmpty) dom.receiptEmpty.style.display = 'flex';
      if (dom.btnPrintReceipt) dom.btnPrintReceipt.disabled = true;
      return;
    }
    const r = receipt;
    dom.receiptNumber.textContent = r.receiptNumber;
    dom.receiptReg.textContent = r.reg;
    dom.receiptType.textContent = r.type;
    dom.receiptSlot.textContent = r.slot;
    dom.receiptEntryTime.textContent = formatReceiptTime(r.entryTime);
    dom.receiptExitTime.textContent = formatReceiptTime(r.exitTime);
    dom.receiptDuration.textContent = formatDurationHM(r.durationSec);
    dom.receiptDurationLong.textContent = formatDuration(r.durationSec);

    const firstDiv = document.getElementById('receipt-fee-itemized');
    const addDiv = document.getElementById('receipt-fee-additional');
    const totalDiv = document.getElementById('receipt-total');
    if (firstDiv) {
      firstDiv.innerHTML =
        '<span class="receipt-fee-item-desc">' + r.entryFeeDesc + '</span>' +
        '<span class="receipt-fee-item-amt">₹' + r.entryFeeAmt.toFixed(2) + '</span>';
    }
    if (addDiv) {
      if (r.additionalHours > 0) {
        addDiv.style.display = '';
        addDiv.innerHTML =
          '<span class="receipt-fee-item-desc">' + r.additionalFeeDesc + '</span>' +
          '<span class="receipt-fee-item-amt">₹' + r.additionalFeeAmt.toFixed(2) + '</span>';
      } else {
        addDiv.style.display = 'none';
      }
    }
    if (totalDiv) {
      totalDiv.textContent = '₹' + r.finalFee.toFixed(2);
    }
    if (dom.receiptDate) {
      dom.receiptDate.textContent = new Date(r.exitTime).toLocaleDateString('en-IN', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    }
    if (dom.receiptEmpty) dom.receiptEmpty.style.display = 'none';
    if (dom.btnPrintReceipt) dom.btnPrintReceipt.disabled = false;
    dom.receiptSection.style.display = 'block';
  }

  function showReceipt(receipt) {
    if (!receipt) {
      lastReceipt = null;
      renderReceipt(null);
      return;
    }
    lastReceipt = receipt;
    goTo('receipt');
    renderReceipt(receipt);
    setTimeout(function () {
      dom.receiptSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  function printReceipt() {
    if (!lastReceipt) {
      toast('No receipt to print.', 'error');
      return;
    }
    goTo('receipt');
    renderReceipt(lastReceipt);
    window.print();
  }

  function hideReceipt() {
    if (dom.receiptSection) dom.receiptSection.style.display = 'none';
    goTo('dashboard');
  }

  // ============================================================
  // UI RENDERING
  // ============================================================
  function renderAll() {
    renderStats();
    renderParkingGrid();
    renderParkingMap();
    renderSearchResults();
    renderQueue();
    refreshOpenSlotDetails();
  }

  function renderStats() {
    let occupied = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].occupied) occupied++;
    }
    const available = TOTAL_SLOTS - occupied;
    dom.statTotal.textContent = TOTAL_SLOTS;
    dom.statAvailable.textContent = available;
    dom.statOccupied.textContent = occupied;
    dom.statQueue.textContent = waitingQueue.size;

    // Grid status line
    if (waitingQueue.isEmpty() && occupied === 0) {
      dom.gridStatus.textContent = 'All slots available';
    } else if (waitingQueue.isEmpty() && occupied > 0) {
      dom.gridStatus.textContent = available + ' of ' + TOTAL_SLOTS + ' slots free';
    } else {
      dom.gridStatus.textContent = available + ' free · ' + waitingQueue.size + ' waiting';
    }
  }

  function renderParkingGrid() {
    renderSlotGrid(dom.parkingGrid, null);
  }

  function renderParkingMap() {
    renderSlotGrid(dom.mapGrid, null);
    updateMapStatus();
  }

  function renderSlotGrid(gridEl, highlightReg) {
    if (!gridEl) return;
    gridEl.innerHTML = '';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const el = document.createElement('div');
      el.className = 'parking-slot';
      if (slot.occupied) {
        el.classList.add('parking-slot--occupied');
      } else {
        el.classList.add('parking-slot--available');
      }
      if (highlightReg && slot.occupied && slot.vehicle.reg === highlightReg) {
        el.classList.add('parking-slot--highlighted');
      }
      el.dataset.index = i;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', slot.id + (slot.occupied ? ', occupied by ' + slot.vehicle.reg : ', available'));

      const idEl = document.createElement('span');
      idEl.className = 'slot-id';
      idEl.textContent = slot.id;

      const iconEl = document.createElement('span');
      iconEl.className = 'slot-icon';
      iconEl.innerHTML = slot.occupied
        ? '<i class="fas fa-car"></i>'
        : '<i class="fas fa-circle"></i>';

      el.appendChild(idEl);
      el.appendChild(iconEl);

      if (slot.occupied) {
        const regEl = document.createElement('span');
        regEl.className = 'slot-reg';
        regEl.textContent = slot.vehicle.reg;
        el.appendChild(regEl);
      }

      // Click + keyboard both open details
      el.addEventListener('click', function () { openSlotDetails(i); });

      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openSlotDetails(i);
        }
      });

      gridEl.appendChild(el);
    }
  }

  function updateMapStatus() {
    if (!dom.mapStatus) return;
    const occupied = countOccupied();
    if (waitingQueue.isEmpty() && occupied === 0) {
      dom.mapStatus.textContent = 'All slots available · Click any slot for details';
    } else if (waitingQueue.isEmpty()) {
      dom.mapStatus.textContent = (TOTAL_SLOTS - occupied) + ' of ' + TOTAL_SLOTS + ' slots free';
    } else {
      dom.mapStatus.textContent = (TOTAL_SLOTS - occupied) + ' free · ' + waitingQueue.size + ' in queue';
    }
  }

  function populateSlotDetails(index) {
    if (index < 0 || index >= slots.length) return;
    const slot = slots[index];
    dom.slotDetId.textContent = slot.id;
    dom.slotDetailsTitle.textContent = 'Slot ' + slot.id;
    if (slot.occupied) {
      const calc = calcFee(slot.vehicle.entryTime, Date.now());
      dom.slotDetailsStatus.textContent = 'Occupied';
      dom.slotDetailsStatus.className = 'slot-details-status slot-details-status--occupied';
      dom.slotDetStatus.textContent = 'Occupied';
      dom.slotDetReg.textContent = slot.vehicle.reg;
      dom.slotDetType.textContent = slot.vehicle.type;
      dom.slotDetEntry.textContent = formatTime(slot.vehicle.entryTime);
      dom.slotDetLiveDuration.textContent = formatDuration(calc.durationSec);
      dom.slotDetLiveFee.textContent = calc.fee === 0 ? 'Free' : formatCurrency(calc.fee);
      dom.slotDetRegRow.style.display = '';
      dom.slotDetTypeRow.style.display = '';
      dom.slotDetEntryRow.style.display = '';
      dom.slotDetLiveFeeRow.style.display = '';
      dom.slotDetLiveDurationRow.style.display = '';
    } else {
      dom.slotDetailsStatus.textContent = 'Available';
      dom.slotDetailsStatus.className = 'slot-details-status slot-details-status--available';
      dom.slotDetStatus.textContent = 'Available';
      dom.slotDetReg.textContent = '—';
      dom.slotDetType.textContent = '—';
      dom.slotDetEntry.textContent = '—';
      dom.slotDetLiveDuration.textContent = '—';
      dom.slotDetLiveFee.textContent = '—';
      dom.slotDetRegRow.style.display = 'none';
      dom.slotDetTypeRow.style.display = 'none';
      dom.slotDetEntryRow.style.display = 'none';
      dom.slotDetLiveFeeRow.style.display = 'none';
      dom.slotDetLiveDurationRow.style.display = 'none';
    }
  }

  function openSlotDetails(index) {
    if (index < 0 || index >= slots.length) return;
    // The details panel lives in the Parking Map section. If a slot is
    // clicked from the Parking Grid, switch to the map so the details are
    // actually visible.
    if (getCurrentVisibleSection() !== 'parkingMap') {
      goTo('parking-map');
    }
    populateSlotDetails(index);
    dom.slotDetails.dataset.index = String(index);
    dom.slotDetails.style.display = 'block';
    // Scroll details into view on mobile
    setTimeout(function () { dom.slotDetails.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 60);
  }

  function refreshOpenSlotDetails() {
    if (!dom.slotDetails || dom.slotDetails.style.display === 'none') return;
    const index = parseInt(dom.slotDetails.dataset.index, 10);
    if (!isNaN(index)) populateSlotDetails(index);
  }

  function closeSlotDetails() {
    if (!dom.slotDetails) return;
    dom.slotDetails.style.display = 'none';
    delete dom.slotDetails.dataset.index;
  }

  function renderHistory(filterReg) {
    let sessions = historyList.toArray();
    const filter = normalizeReg(filterReg);
    if (filter) {
      sessions = sessions.filter(function (s) { return s.reg.indexOf(filter) !== -1; });
    }
    const sortKey = dom.sortSelect.value;
    const comparator = (SESSION_COMPARATORS[sortKey] || SESSION_COMPARATORS['entry']);
    sessions = mergeSort(sessions, comparator);

    dom.historyTbody.innerHTML = '';
    if (sessions.length === 0) {
      const emptyText = document.getElementById('history-empty-text');
      if (emptyText) {
        emptyText.textContent = filter
          ? 'No sessions match "' + filter + '".'
          : 'No parking sessions recorded yet.';
      }
      dom.historyEmpty.style.display = 'flex';
      return;
    }
    dom.historyEmpty.style.display = 'none';

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const tr = document.createElement('tr');
      const receiptTd = s.receiptNumber
        ? '<td><strong>' + s.receiptNumber + '</strong></td>'
        : '<td>—</td>';
      tr.innerHTML =
        '<td>' + s.id + '</td>' +
        receiptTd +
        '<td><strong>' + s.reg + '</strong></td>' +
        '<td>' + s.type + '</td>' +
        '<td>' + s.slot + '</td>' +
        '<td>' + formatTime(s.entryTime) + '</td>' +
        '<td>' + formatTime(s.exitTime) + '</td>' +
        '<td>' + formatDuration(s.duration) + '</td>' +
        '<td>' + (s.fee === 0 ? 'Free' : formatCurrency(s.fee)) + '</td>';
      dom.historyTbody.appendChild(tr);
    }
  }

  // ============================================================
  // SMART VEHICLE SEARCH
  // ============================================================
  function countOccupied() {
    let n = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].occupied) n++;
    }
    return n;
  }

  function getAllActiveVehicles() {
    // Returns active parked vehicles + queued vehicles with their current status
    const parked = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].occupied) {
        parked.push({
          reg: slots[i].vehicle.reg,
          type: slots[i].vehicle.type,
          status: 'Parked',
          slot: slots[i].id,
          slotIndex: i,
          entryTime: slots[i].vehicle.entryTime,
          queued: false,
        });
      }
    }
    const queued = [];
    const items = waitingQueue.toArray();
    for (let i = 0; i < items.length; i++) {
      queued.push({
        reg: items[i].reg,
        type: items[i].type,
        status: 'Waiting',
        slot: '—',
        slotIndex: -1,
        entryTime: items[i].entryTime,
        queued: true,
        queuePosition: i + 1,
      });
    }
    // Parked first (sorted by entry time desc by default), then queued FIFO
    return parked.concat(queued);
  }

  function renderSearchResults() {
    const regFilter = dom.searchReg ? normalizeReg(dom.searchReg.value) : '';
    const typeFilter = dom.searchType ? dom.searchType.value : '';
    const sortKey = dom.searchSort ? dom.searchSort.value : 'entry-desc';

    let results = getAllActiveVehicles();

    // Filter by registration (substring match)
    if (regFilter) {
      results = results.filter(function (v) { return v.reg.indexOf(regFilter) !== -1; });
    }
    // Filter by type
    if (typeFilter) {
      results = results.filter(function (v) { return v.type === typeFilter; });
    }

    // Sort
    if (sortKey === 'entry-desc') {
      results.sort(function (a, b) { return b.entryTime - a.entryTime; });
    } else if (sortKey === 'entry-asc') {
      results.sort(function (a, b) { return a.entryTime - b.entryTime; });
    } else if (sortKey === 'duration') {
      const now = Date.now();
      results.sort(function (a, b) {
        const dA = (now - a.entryTime) / 1000;
        const dB = (now - b.entryTime) / 1000;
        return dB - dA;
      });
    }

    // Count
    if (dom.searchCount) {
      dom.searchCount.textContent = results.length + ' vehicle' + (results.length !== 1 ? 's' : '') + ' found';
    }

    // Render results grid
    if (dom.searchResultsGrid) {
      dom.searchResultsGrid.innerHTML = '';
      if (results.length === 0) {
        if (dom.searchEmpty) dom.searchEmpty.style.display = 'flex';
        return;
      }
      if (dom.searchEmpty) dom.searchEmpty.style.display = 'none';

      for (let i = 0; i < results.length; i++) {
        const v = results[i];
        const card = document.createElement('div');
        card.className = 'search-result-card';
        if (v.queued) card.classList.add('search-result-card--queued');
        card.innerHTML =
          '<div class="search-result-top">' +
            '<span class="search-result-reg">' + v.reg + '</span>' +
            '<span class="search-result-badge">' + v.status + '</span>' +
          '</div>' +
          '<div class="search-result-type">' + v.type + '</div>';
        if (!v.queued) {
          card.innerHTML +=
            '<div class="search-result-slot"><i class="fas fa-square"></i> ' + v.slot + '</div>';
        } else {
          card.innerHTML +=
            '<div class="search-result-slot"><i class="fas fa-clock"></i> Position ' + v.queuePosition + '</div>';
        }
        card.innerHTML +=
          '<div class="search-result-entry">Entered ' + formatTime(v.entryTime) + '</div>';

        // Click to highlight slot on map + open details
        card.addEventListener('click', function () {
          if (!v.queued && v.slotIndex >= 0) {
            goTo('parking-map', v.reg);
            openSlotDetails(v.slotIndex);
          } else {
            toast('Cannot highlight: ' + v.reg + ' is in the waiting queue.', 'info');
          }
        });
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            card.click();
          }
        });

        dom.searchResultsGrid.appendChild(card);
      }
    }
  }

  // ============================================================
  // WAITING QUEUE DISPLAY
  // ============================================================
  function renderQueue() {
    if (!dom.queueSection) return;
    const items = waitingQueue.toArray();
    const now = Date.now();

    dom.queueSection.style.display = 'block';
    if (items.length === 0) {
      dom.queueEmpty.style.display = 'flex';
      dom.queueList.innerHTML = '';
      return;
    }

    dom.queueEmpty.style.display = 'none';

    dom.queueList.innerHTML = '';
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const waitingSec = (now - item.entryTime) / 1000;
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.innerHTML =
        '<div class="queue-pos">' + (i + 1) + '</div>' +
        '<div class="queue-info">' +
          '<div class="queue-reg">' + item.reg + '</div>' +
          '<div class="queue-meta">' + item.type + ' · Waiting ' + formatDuration(waitingSec) + '</div>' +
        '</div>' +
        '<button class="queue-cancel" data-reg="' + item.reg + '" title="Cancel request"><i class="fas fa-times"></i></button>';
      dom.queueList.appendChild(row);
    }
  }

  // ============================================================
  // QUEUE CANCELLATION
  // ============================================================
  function cancelQueueRequest(reg) {
    const cleaned = normalizeReg(reg);
    const items = waitingQueue.toArray();
    const idx = items.findIndex(function (item) { return item.reg === cleaned; });
    if (idx === -1) {
      toast('Vehicle ' + cleaned + ' is not in the waiting queue.', 'error');
      return;
    }
    if (!confirm('Remove ' + cleaned + ' from the waiting queue?')) return;
    // Rebuild queue without that item
    const newItems = items.filter(function (item, i) { return i !== idx; });
    waitingQueue = createQueue();
    for (let i = 0; i < newItems.length; i++) {
      waitingQueue.enqueue(newItems[i]);
    }
    saveState();
    renderAll();
    toast(cleaned + ' removed from queue.', 'info');
  }

  // ============================================================
  // NAVIGATION
  // ============================================================
  // Normalize nav data-section values to dom.sections keys
  const SECTION_KEY = {
    'dashboard': 'dashboard',
    'parking-map': 'parkingMap',
    'parking-grid': 'parkingGrid',
    'entry': 'entry',
    'search': 'search',
    'exit': 'exit',
    'history': 'history',
    'receipt': 'receipt',
  };

  // Canonical data-section value for each internal section key.
  const SECTION_NAV = {
    dashboard: 'dashboard',
    parkingMap: 'parking-map',
    parkingGrid: 'parking-grid',
    entry: 'entry',
    search: 'search',
    exit: 'exit',
    history: 'history',
    receipt: 'receipt',
  };

  let _pendingHighlightReg = null;

  function goTo(section, highlightReg) {
    if (highlightReg) _pendingHighlightReg = highlightReg;
    const key = SECTION_KEY[section] || section;
    if (!dom.sections[key]) {
      console.error('Unknown section key:', key);
      return;
    }

    // Hide all sections
    Object.keys(dom.sections).forEach(function (k) {
      if (dom.sections[k]) dom.sections[k].style.display = 'none';
    });
    // Close slot details when leaving map
    if (key !== 'parkingMap') closeSlotDetails();
    if (key !== 'parkingMap') _pendingHighlightReg = null;

    // Render sections that need live data before they become visible.
    if (key === 'history') {
      renderHistory(dom.historySearch.value);
    }
    if (key === 'parkingGrid') {
      renderParkingGrid();
    }
    if (key === 'parkingMap') {
      renderParkingMap();
      if (_pendingHighlightReg) {
        renderSlotGrid(dom.mapGrid, _pendingHighlightReg);
        _pendingHighlightReg = null;
      }
    }
    if (key === 'search') {
      renderSearchResults();
    }

    dom.sections[key].style.display = '';
    if (key === 'receipt') {
      renderReceipt(lastReceipt);
    }

    const navSection = SECTION_NAV[key] || section;
    dom.topbarTitle.textContent = getSectionTitle(navSection);
    currentSection = navSection;

    // Update nav active state
    dom.navItems.forEach(function (item) {
      item.classList.toggle('active', item.dataset.section === navSection);
    });

    // Keep the URL hash in sync with the visible section, including sections
    // opened programmatically (for example the receipt after an exit).
    const newHash = '#' + navSection;
    if (location.hash !== newHash) {
      try {
        history.replaceState(null, '', newHash);
      } catch (e) {
        location.hash = navSection;
      }
    }

    // Close mobile sidebar on selection
    dom.sidebar.classList.remove('open');
  }

  function sectionFromHash(hash) {
    if (!hash) return 'dashboard';
    const map = {
      '#dashboard': 'dashboard',
      '#grid': 'parkingGrid',
      '#parking-grid': 'parkingGrid',
      '#parking-map': 'parkingMap',
      '#entry': 'entry',
      '#search': 'search',
      '#exit': 'exit',
      '#history': 'history',
      '#receipt': 'receipt',
    };
    return map[hash] || null;
  }

  function applyHash() {
    const section = sectionFromHash(location.hash);
    if (section) goTo(section);
    else goTo('dashboard');
  }

  function getSectionTitle(section) {
    const titles = {
      dashboard: 'Dashboard',
      'parking-map': 'Parking Map',
      parkingMap: 'Parking Map',
      'parking-grid': 'Parking Grid',
      parkingGrid: 'Parking Grid',
      entry: 'Vehicle Entry',
      search: 'Vehicle Search',
      exit: 'Vehicle Exit',
      history: 'Parking History',
      receipt: 'Parking Receipt',
    };
    return titles[section] || 'Dashboard';
  }

  // ============================================================
  // FEEDBACK HELPERS
  // ============================================================
  function showEntryFeedback(msg, kind) {
    const fb = dom.entryFeedback;
    fb.className = 'feedback feedback--' + kind;
    fb.innerHTML = '<i class="fas ' + (kind === 'success' ? 'fa-check-circle' : kind === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle') + '"></i> ' + msg;
    fb.style.display = 'flex';
  }

  function hideEntryFeedback() {
    dom.entryFeedback.style.display = 'none';
  }

  function showExitFeedback(msg, kind) {
    const fb = dom.exitFeedback;
    fb.className = 'feedback feedback--' + kind;
    fb.innerHTML = '<i class="fas ' + (kind === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle') + '"></i> ' + msg;
    fb.style.display = 'flex';
  }

  function hideExitFeedback() {
    dom.exitFeedback.style.display = 'none';
  }

  // ============================================================
  // TOAST
  // ============================================================
  function toast(msg, kind) {
    const container = dom.toastContainer;
    const el = document.createElement('div');
    el.className = 'toast toast--' + (kind || 'info');
    el.innerHTML = '<i class="fas ' + (kind === 'success' ? 'fa-check-circle' : kind === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle') + '"></i> ' + msg;
    container.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) {
        el.style.transition = 'opacity 0.25s';
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 260);
      }
    }, 4000);
  }

  // ============================================================
  // EVENT BINDING
  // ============================================================
  let currentSection = 'dashboard';

  function bindEvents() {
    // Navigation
    dom.navItems.forEach(function (item) {
      item.addEventListener('click', function (e) {
        const raw = item.dataset.section;
        if (!raw) return;
        e.preventDefault();
        goTo(raw);
        if (history.replaceState) {
          history.replaceState(null, '', '#' + raw);
        } else {
          location.hash = raw;
        }
      });
    });

    // Hash change navigation (deep links / back button)
    window.addEventListener('hashchange', function () {
      const section = sectionFromHash(location.hash);
      if (!section) return;
      const key = SECTION_KEY[section] || section;
      if (SECTION_NAV[key] !== currentSection) {
        goTo(section);
      }
    });

    // Mobile toggle
    dom.mobileToggle.addEventListener('click', function () {
      dom.sidebar.classList.toggle('open');
    });

    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', function (e) {
      if (window.innerWidth > 768) return;
      if (!dom.sidebar.contains(e.target) && !dom.mobileToggle.contains(e.target)) {
        dom.sidebar.classList.remove('open');
      }
    });

    // Entry form
    dom.entryForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const reg = dom.entryReg.value;
      const type = dom.entryType.value;
      handleEntry(reg, type);
    });
    dom.entryReg.addEventListener('input', hideEntryFeedback);

    // Exit search
    dom.btnSearchExit.addEventListener('click', function () {
      searchExitVehicle(dom.exitReg.value);
    });
    dom.exitForm.addEventListener('submit', function (e) {
      e.preventDefault();
      searchExitVehicle(dom.exitReg.value);
    });
    dom.exitReg.addEventListener('input', function () {
      if (dom.exitResult.style.display !== 'none') cancelExit();
    });

    dom.btnExitConfirm.addEventListener('click', confirmExit);
    dom.btnExitCancel.addEventListener('click', cancelExit);

    // Parking map: slot details close
    if (dom.slotDetailsClose) {
      dom.slotDetailsClose.addEventListener('click', closeSlotDetails);
    }

    // Smart vehicle search
    let searchTimer = null;
    function runSearch() {
      renderSearchResults();
      // Also refresh highlighting on the map when it is the visible section.
      if (dom.sections.parkingMap && dom.sections.parkingMap.style.display !== 'none') {
        renderSlotGrid(dom.mapGrid, normalizeReg(dom.searchReg.value) || null);
      }
    }
    dom.searchReg.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 120);
    });
    dom.searchType.addEventListener('change', runSearch);
    dom.searchSort.addEventListener('change', runSearch);

    // Queue cancel via delegation
    if (dom.queueList) {
      dom.queueList.addEventListener('click', function (e) {
        const btn = e.target.closest('.queue-cancel');
        if (!btn) return;
        const reg = btn.getAttribute('data-reg');
        if (!reg) return;
        cancelQueueRequest(reg);
      });
    }

    // History search + sort
    let historySearchTimer = null;
    dom.historySearch.addEventListener('input', function () {
      clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(function () {
        renderHistory(dom.historySearch.value);
      }, 200);
    });
    dom.sortSelect.addEventListener('change', function () {
      renderHistory(dom.historySearch.value);
    });

    // Receipt
    if (dom.btnPrintReceipt) {
      dom.btnPrintReceipt.addEventListener('click', printReceipt);
    }
    if (dom.btnReceiptClose) {
      dom.btnReceiptClose.addEventListener('click', hideReceipt);
    }

    // Reset
    dom.btnReset.addEventListener('click', resetState);

    // Keyboard shortcut: focus reg inputs
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !isInInput(e.target)) {
        e.preventDefault();
        const activeSec = getCurrentVisibleSection();
        if (activeSec === 'entry') dom.entryReg.focus();
        else if (activeSec === 'exit') dom.exitReg.focus();
        else if (activeSec === 'history') dom.historySearch.focus();
      }
    });
  }

  function isInInput(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
  }

  function getCurrentVisibleSection() {
    for (const key of Object.keys(dom.sections)) {
      if (dom.sections[key].style.display !== 'none') return key;
    }
    return 'dashboard';
  }

  // ============================================================
  // LIVE DURATION TIMER
  // ============================================================
  let timerInterval = null;

  function startLiveTimer() {
    stopLiveTimer();
    timerInterval = setInterval(function () {
      // Update the open slot details panel with the latest duration/fee.
      refreshOpenSlotDetails();
      // Update queue waiting durations
      if (dom.queueList && dom.queueList.children.length > 0) {
        renderQueue();
      }
    }, 1000);
  }

  function stopLiveTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    const restored = loadState();
    // Ensure slot count integrity on restore
    if (slots.length !== TOTAL_SLOTS) {
      slots = createSlotArray();
      waitingQueue = createQueue();
      historyList = createLinkedList();
      vehicleTable = createVehicleHashTable();
      sessionCounter = 0;
      receiptCounter = 0;
      lastReceipt = null;
    }
    bindEvents();
    renderAll();
    applyHash();
    renderReceipt(lastReceipt);
    startLiveTimer();
    if (restored) {
      toast('Restored ' + historyList.length + ' history records from last session.', 'info');
    }
  }

  init();
})();
