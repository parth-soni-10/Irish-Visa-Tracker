/**
 * Vanilla JS Calendar Component - shadcn/ui style
 * A vanilla JavaScript calendar component that mimics the shadcn/ui calendar design
 */

(function() {
  'use strict';

  // Calendar Component
  class Calendar {
    constructor(options = {}) {
      this.input = options.input;
      this.onSelect = options.onSelect || (() => {});
      this.onClose = options.onClose || (() => {});
      this.mode = options.mode || 'single'; // 'single', 'range', 'multiple'
      this.minDate = options.minDate || null;
      this.maxDate = options.maxDate || null;
      this.disabledDates = options.disabledDates || [];
      this.initialDate = options.initialDate || new Date();
      
      this.currentDate = new Date(this.initialDate);
      this.selectedDates = this.mode === 'range' ? [] : (this.mode === 'multiple' ? [] : null);
      this.isOpen = false;
      this.popper = null;
      
      this.init();
    }

    init() {
      this.createCalendar();
      this.bindEvents();
      this.render();
    }

    createCalendar() {
      // Create calendar container
      this.calendar = document.createElement('div');
      this.calendar.className = 'shadcn-calendar';
      this.calendar.innerHTML = this.getTemplate();
      document.body.appendChild(this.calendar);
      
      // Get references
      this.header = this.calendar.querySelector('.calendar-header');
      this.grid = this.calendar.querySelector('.calendar-grid');
      this.prevBtn = this.calendar.querySelector('.calendar-prev');
      this.nextBtn = this.calendar.querySelector('.calendar-next');
      this.currentMonthEl = this.calendar.querySelector('.calendar-current-month');
    }

    getTemplate() {
      return `
        <div class="calendar-popover">
          <div class="calendar-header">
            <button type="button" class="calendar-nav calendar-prev" aria-label="Previous month">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 18l-6-6 6-6"></path>
              </svg>
            </button>
            <div class="calendar-current-month"></div>
            <button type="button" class="calendar-nav calendar-next" aria-label="Next month">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18l6-6-6-6"></path>
              </svg>
            </button>
          </div>
          <div class="calendar-weekdays">
            <div>Su</div>
            <div>Mo</div>
            <div>Tu</div>
            <div>We</div>
            <div>Th</div>
            <div>Fr</div>
            <div>Sa</div>
          </div>
          <div class="calendar-grid"></div>
        </div>
      `;
    }

    bindEvents() {
      this.prevBtn.addEventListener('click', () => this.navigateMonth(-1));
      this.nextBtn.addEventListener('click', () => this.navigateMonth(1));
      
      this.grid.addEventListener('click', (e) => {
        const dayEl = e.target.closest('.calendar-day:not(.disabled):not(.outside)');
        if (dayEl) {
          const date = new Date(dayEl.dataset.date);
          this.selectDate(date);
        }
      });

      // Close on outside click
      document.addEventListener('click', (e) => {
        if (this.isOpen && !this.calendar.contains(e.target) && this.input !== e.target) {
          this.close();
        }
      });

      // Keyboard navigation
      this.calendar.addEventListener('keydown', (e) => this.handleKeydown(e));
      
      // Input focus
      if (this.input) {
        this.input.addEventListener('focus', () => this.open());
        this.input.addEventListener('click', () => this.open());
      }
    }

    handleKeydown(e) {
      if (!this.isOpen) return;
      
      const selectedDay = this.grid.querySelector('.calendar-day.selected:not(.outside)');
      if (!selectedDay) return;

      let newDate = new Date(selectedDay.dataset.date);
      
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          newDate.setDate(newDate.getDate() - 1);
          this.navigateToDate(newDate);
          break;
        case 'ArrowRight':
          e.preventDefault();
          newDate.setDate(newDate.getDate() + 1);
          this.navigateToDate(newDate);
          break;
        case 'ArrowUp':
          e.preventDefault();
          newDate.setDate(newDate.getDate() - 7);
          this.navigateToDate(newDate);
          break;
        case 'ArrowDown':
          e.preventDefault();
          newDate.setDate(newDate.getDate() + 7);
          this.navigateToDate(newDate);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          this.selectDate(newDate);
          break;
        case 'Escape':
          this.close();
          break;
      }
    }

    navigateMonth(delta) {
      this.currentDate.setMonth(this.currentDate.getMonth() + delta);
      this.render();
    }

    navigateToDate(date) {
      this.currentDate = new Date(date);
      this.render();
      this.focusDate(date);
    }

    focusDate(date) {
      const dayEl = this.grid.querySelector(`[data-date="${this.formatDateKey(date)}"]`);
      if (dayEl) {
        dayEl.focus();
      }
    }

    render() {
      // Update header
      this.currentMonthEl.textContent = this.currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      
      // Render days
      this.grid.innerHTML = this.getDaysHtml();
    }

    getDaysHtml() {
      const year = this.currentDate.getFullYear();
      const month = this.currentDate.getMonth();
      
      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0);
      const startDay = firstDay.getDay(); // 0 = Sunday
      const daysInMonth = lastDay.getDate();
      
      const prevMonthLastDay = new Date(year, month, 0).getDate();
      
      let html = '';
      let day = 1;
      let nextMonthDay = 1;
      
      // 6 weeks max
      for (let week = 0; week < 6; week++) {
        for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
          if (week === 0 && dayOfWeek < startDay) {
            // Previous month days
            const prevDay = prevMonthLastDay - startDay + dayOfWeek + 1;
            const date = new Date(year, month - 1, prevDay);
            html += this.renderDay(date, true, false);
          } else if (day > daysInMonth) {
            // Next month days
            const date = new Date(year, month + 1, nextMonthDay);
            html += this.renderDay(date, true, false);
            nextMonthDay++;
          } else {
            // Current month days
            const date = new Date(year, month, day);
            html += this.renderDay(date, false, false);
            day++;
          }
        }
      }
      
      return html;
    }

    renderDay(date, isOutside, preDisabled) {
      const dateKey = this.formatDateKey(date);
      const isSelected = this.isDateSelected(date);
      const isToday = this.isToday(date);
      const isDisabled = preDisabled || this.isDateDisabled(date) || isOutside;
      const isInRange = this.mode === 'range' && this.isDateInRange(date);
      const isRangeStart = this.mode === 'range' && this.isRangeStart(date);
      const isRangeEnd = this.mode === 'range' && this.isRangeEnd(date);
      
      let classes = 'calendar-day';
      if (isOutside) classes += ' outside';
      if (isDisabled) classes += ' disabled';
      if (isSelected) classes += ' selected';
      if (isToday) classes += ' today';
      if (isInRange) classes += ' in-range';
      if (isRangeStart) classes += ' range-start';
      if (isRangeEnd) classes += ' range-end';
      
      return `
        <button 
          type="button" 
          class="${classes}" 
          data-date="${dateKey}"
          aria-label="${date.toLocaleDateString()}"
          aria-selected="${isSelected}"
          aria-disabled="${isDisabled}"
          ${isDisabled ? 'disabled' : ''}
          tabindex="${isDisabled ? -1 : 0}"
        >
          ${date.getDate()}
          ${isToday ? '<span class="today-indicator"></span>' : ''}
        </button>
      `;
    }

    isDateSelected(date) {
      if (this.mode === 'single') {
        return this.selectedDates && this.formatDateKey(this.selectedDates) === this.formatDateKey(date);
      }
      if (this.mode === 'range') {
        return this.selectedDates && this.selectedDates.length === 2 &&
               this.formatDateKey(this.selectedDates[0]) === this.formatDateKey(date) ||
               this.formatDateKey(this.selectedDates[1]) === this.formatDateKey(date);
      }
      if (this.mode === 'multiple') {
        return this.selectedDates && this.selectedDates.some(d => this.formatDateKey(d) === this.formatDateKey(date));
      }
      return false;
    }

    isDateInRange(date) {
      if (this.mode !== 'range' || !this.selectedDates || this.selectedDates.length !== 2) return false;
      const start = new Date(this.selectedDates[0]);
      const end = new Date(this.selectedDates[1]);
      return date >= start && date <= end;
    }

    isRangeStart(date) {
      if (this.mode !== 'range' || !this.selectedDates || this.selectedDates.length !== 2) return false;
      return this.formatDateKey(this.selectedDates[0]) === this.formatDateKey(date);
    }

    isRangeEnd(date) {
      if (this.mode !== 'range' || !this.selectedDates || this.selectedDates.length !== 2) return false;
      return this.formatDateKey(this.selectedDates[1]) === this.formatDateKey(date);
    }

    isToday(date) {
      const today = new Date();
      return this.formatDateKey(date) === this.formatDateKey(today);
    }

    isDateDisabled(date) {
      if (this.minDate && date < new Date(this.minDate)) return true;
      if (this.maxDate && date > new Date(this.maxDate)) return true;
      return this.disabledDates.some(d => this.formatDateKey(d) === this.formatDateKey(date));
    }

    selectDate(date) {
      if (this.isDateDisabled(date)) return;

      if (this.mode === 'single') {
        this.selectedDates = date;
        this.onSelect(date);
        this.close();
      } else if (this.mode === 'range') {
        if (!this.selectedDates || this.selectedDates.length === 2) {
          this.selectedDates = [date];
        } else if (this.selectedDates.length === 1) {
          if (date < this.selectedDates[0]) {
            this.selectedDates.unshift(date);
          } else {
            this.selectedDates.push(date);
          }
          this.onSelect(this.selectedDates[0], this.selectedDates[1]);
        }
      } else if (this.mode === 'multiple') {
        const idx = this.selectedDates.findIndex(d => this.formatDateKey(d) === this.formatDateKey(date));
        if (idx === -1) {
          this.selectedDates.push(date);
        } else {
          this.selectedDates.splice(idx, 1);
        }
        this.onSelect(this.selectedDates);
      }
      this.render();
    }

    open() {
      if (this.isOpen) return;
      this.isOpen = true;
      this.calendar.classList.add('open');
      this.positionPopper();
      this.render();
      this.focusDate(this.initialDate || new Date());
    }

    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.calendar.classList.remove('open');
      this.onClose();
    }

    positionPopper() {
      if (!this.input) return;
      const rect = this.input.getBoundingClientRect();
      this.calendar.style.top = `${rect.bottom + window.scrollY + 4}px`;
      this.calendar.style.left = `${rect.left + window.scrollX}px`;
    }

    formatDateKey(date) {
      return date.toISOString().split('T')[0];
    }

    formatDate(date) {
      return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    destroy() {
      if (this.calendar && this.calendar.parentNode) {
        this.calendar.parentNode.removeChild(this.calendar);
      }
    }
  }

  // Factory function
  window.ShadcnCalendar = function(input, options) {
    return new Calendar(input, options);
  };

  // Styles live in calendar-component.css so the CSP can forbid inline <style>.

})();