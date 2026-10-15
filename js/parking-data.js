/* ============================================================
   Smart Parking Manager — Parking Data Module
   Implements: slot array, waiting queue, session history list,
              vehicle lookup map, and record sorting — all in
   plain JavaScript.
   ============================================================ */

/**
 * ---------------------------------------------------------------------------
 * 1. SLOT ARRAY — Parking slots
 *    A flat array of 20 slot objects (P01..P20). Each slot holds its status
 *    and, when occupied, the vehicle parked in it. This is the core slot
 *    table that the dashboard renders.
 * ---------------------------------------------------------------------------
 */
const TOTAL_SLOTS = 20;

/** Factory: create the initial slot array (all empty). */
function createSlotArray() {
  const slots = [];
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    slots.push({
      id: 'P' + String(i).padStart(2, '0'),
      index: i - 1,
      occupied: false,
      vehicle: null, // { reg, type, entryTime } when occupied
    });
  }
  return slots;
}

/** Find the first available slot index in the array, or -1. */
function findFirstAvailableSlot(slots) {
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i].occupied) return i;
  }
  return -1;
}

/** Occupy a slot with a vehicle record. */
function occupySlot(slots, index, vehicle) {
  slots[index].occupied = true;
  slots[index].vehicle = vehicle;
}

/** Vacate a slot, returning the vehicle that was parked there. */
function vacateSlot(slots, index) {
  const vehicle = slots[index].vehicle;
  slots[index].occupied = false;
  slots[index].vehicle = null;
  return vehicle;
}

/** Deep-clone the slot array for storage. */
function cloneSlots(slots) {
  return slots.map((s) => ({ ...s, vehicle: s.vehicle ? { ...s.vehicle } : null }));
}

/* ---------------------------------------------------------------------------
 * 2. WAITING QUEUE — First-in, first-out
 *    A queue built on a plain array, exposing enqueue / dequeue / peek /
 *    isEmpty, plus a size property. Vehicles that arrive when the lot is
 *    full line up here and are served in arrival order.
 * ---------------------------------------------------------------------------
 */
function createQueue() {
  return {
    _items: [],
    get size() {
      return this._items.length;
    },
    isEmpty() {
      return this._items.length === 0;
    },
    enqueue(item) {
      this._items.push(item);
    },
    dequeue() {
      if (this.isEmpty()) return null;
      return this._items.shift();
    },
    peek() {
      if (this.isEmpty()) return null;
      return this._items[0];
    },
    toArray() {
      return this._items.slice();
    },
    fromArray(arr) {
      this._items = arr.slice();
    },
    clone() {
      const q = createQueue();
      q.fromArray(this._items);
      return q;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 3. SESSION HISTORY — Linked list
 *    Each completed parking session is stored as a node. New sessions are
 *    appended to the tail so history stays in chronological insertion order.
 *    The list can be traversed into an array for rendering and sorting.
 * ---------------------------------------------------------------------------
 */
function createHistoryNode(session) {
  return {
    session: session, // { id, reg, type, slot, entryTime, exitTime, duration, fee }
    next: null,
  };
}

function createLinkedList() {
  return {
    _head: null,
    _tail: null,
    _length: 0,

    isEmpty() {
      return this._head === null;
    },

    get length() {
      return this._length;
    },

    /** Append a new session node at the tail (chronological order). */
    push(session) {
      const node = createHistoryNode(session);
      if (this._head === null) {
        this._head = node;
        this._tail = node;
      } else {
        this._tail.next = node;
        this._tail = node;
      }
      this._length++;
    },

    /** Convert the whole list into an array (for rendering / sorting). */
    toArray() {
      const arr = [];
      let current = this._head;
      while (current !== null) {
        arr.push(current.session);
        current = current.next;
      }
      return arr;
    },

    /** Build the list from an array (used when restoring from storage). */
    fromArray(arr) {
      this._head = null;
      this._tail = null;
      this._length = 0;
      if (arr && arr.length) {
        for (const session of arr) {
          this.push(session);
        }
      }
    },

    clear() {
      this._head = null;
      this._tail = null;
      this._length = 0;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 4. VEHICLE LOOKUP — Registration number index
 *    A keyed collection that maps each registration number to its active
 *    parking record and slot position. This makes vehicle search, duplicate
 *    checking, and exit processing fast regardless of how many vehicles are
 *    currently parked.
 *
 *    Keys: registration number (string)   →   Value: active vehicle record
 *    Also stores the slot index so exit can find and free the right slot.
 * ---------------------------------------------------------------------------
 */
function createVehicleHashTable() {
  return {
    _map: new Map(),

    /** Insert / update a vehicle record for a registration. */
    put(reg, slotIndex, vehicleRecord) {
      this._map.set(reg, { slotIndex, vehicle: vehicleRecord });
    },

    /** Look up a vehicle by registration. Returns the record or undefined. */
    get(reg) {
      const entry = this._map.get(reg);
      if (entry) {
        return { slotIndex: entry.slotIndex, vehicle: entry.vehicle };
      }
      return undefined;
    },

    /** Remove a vehicle by registration. */
    remove(reg) {
      this._map.delete(reg);
    },

    /** Check whether a registration is currently active. */
    has(reg) {
      return this._map.has(reg);
    },

    /** Return all active registrations (for duplicate checks, etc.). */
    keys() {
      return Array.from(this._map.keys());
    },

    /** Size of the table. */
    get size() {
      return this._map.size;
    },

    /** Export for storage. */
    toObject() {
      const obj = {};
      for (const [reg, value] of this._map) {
        obj[reg] = { slotIndex: value.slotIndex, vehicle: value.vehicle };
      }
      return obj;
    },

    /** Restore from a plain object. */
    fromObject(obj) {
      this._map.clear();
      if (!obj) return;
      for (const [reg, value] of Object.entries(obj)) {
        this._map.set(reg, value);
      }
    },
  };
}

/* ---------------------------------------------------------------------------
 * 5. RECORD SORTING — Merge sort
 *    A divide-and-conquer merge sort over an array of session objects.
 *    The caller supplies a comparator so the same sort routine can order
 *    records by entry time, duration, or fee. This gives a real O(n log n)
 *    comparison sort implemented directly rather than delegated to
 *    Array.sort.
 * ---------------------------------------------------------------------------
 */

/**
 * Merge two already-sorted arrays using the comparator.
 */
function merge(left, right, compare) {
  const result = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (compare(left[i], right[j]) <= 0) {
      result.push(left[i]);
      i++;
    } else {
      result.push(right[j]);
      j++;
    }
  }
  while (i < left.length) {
    result.push(left[i]);
    i++;
  }
  while (j < right.length) {
    result.push(right[j]);
    j++;
  }
  return result;
}

/**
 * Recursively merge-sort an array.
 */
function mergeSort(arr, compare) {
  if (arr.length <= 1) return arr.slice();
  const mid = Math.floor(arr.length / 2);
  const left = mergeSort(arr.slice(0, mid), compare);
  const right = mergeSort(arr.slice(mid), compare);
  return merge(left, right, compare);
}

/* ---------------------------------------------------------------------------
 * Comparators used by the history sort control.
 * ---------------------------------------------------------------------------
 */
const SESSION_COMPARATORS = {
  // Newest entry first
  'entry': (a, b) => {
    if (b.entryTime < a.entryTime) return -1;
    if (b.entryTime > a.entryTime) return 1;
    return 0;
  },
  // Oldest entry first
  'entry-asc': (a, b) => {
    if (a.entryTime < b.entryTime) return -1;
    if (a.entryTime > b.entryTime) return 1;
    return 0;
  },
  // Longest duration first
  'duration': (a, b) => {
    if (b.duration < a.duration) return -1;
    if (b.duration > a.duration) return 1;
    return 0;
  },
  // Highest fee first
  'fee': (a, b) => {
    if (b.fee < a.fee) return -1;
    if (b.fee > a.fee) return 1;
    return 0;
  },
};
