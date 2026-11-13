(function() {
        const embassyData = {
            'new-delhi': {
                flag: '🇮🇳',
                name: 'New Delhi',
                countries: ['India', 'Bangladesh', 'Nepal', 'Sri Lanka'],
                vacs: [
                    { city: 'New Delhi', address: 'VFS Global, 3rd Floor, Tower A, Building No. 10, DLF Cyber City, Phase II, Gurugram, Haryana 122002', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-124-4859900', email: 'info.ind@vfsglobal.com' },
                    { city: 'Mumbai', address: 'VFS Global, 3rd Floor, Trade Center, Bandra Kurla Complex, Bandra East, Mumbai 400051', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-22-67866000', email: 'info.ind@vfsglobal.com' },
                    { city: 'Chennai', address: 'VFS Global, 2nd Floor, Raheja Towers, 177 Anna Salai, Chennai 600002', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-44-42918500', email: 'info.ind@vfsglobal.com' },
                    { city: 'Kolkata', address: 'VFS Global, 4th Floor, 3A Chowringhee Lane, Kolkata 700016', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-33-46018500', email: 'info.ind@vfsglobal.com' },
                    { city: 'Bangalore', address: 'VFS Global, 2nd Floor, HMG Ambassador, 13/1 Residency Road, Bangalore 560025', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-80-46488500', email: 'info.ind@vfsglobal.com' },
                    { city: 'Hyderabad', address: 'VFS Global, 4th Floor, Babukhan Estate, Basheerbagh, Hyderabad 500001', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-40-48528500', email: 'info.ind@vfsglobal.com' },
                    { city: 'Ahmedabad', address: 'VFS Global, 4th Floor, Shivalik Plaza, IIM Road, Ahmedabad 380015', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-79-48008500', email: 'info.ind@vfsglobal.com' },
                    { city: 'Pune', address: 'VFS Global, 3rd Floor, Westin Pune Koregaon Park, Mundhwa Road, Pune 411001', hours: 'Mon-Fri: 08:00-15:00', phone: '+91-20-67308500', email: 'info.ind@vfsglobal.com' },
                    { city: 'Dhaka', address: 'VFS Global, 4th Floor, Sheltech Tower, 82-84 Gulshan Avenue, Dhaka 1212', hours: 'Sun-Thu: 08:00-15:00', phone: '+880-2-58815400', email: 'info.bgd@vfsglobal.com' },
                    { city: 'Kathmandu', address: 'VFS Global, 2nd Floor, Gyaneshwor Complex, Kathmandu', hours: 'Sun-Fri: 08:00-15:00', phone: '+977-1-4548500', email: 'info.npl@vfsglobal.com' },
                    { city: 'Colombo', address: 'VFS Global, 2nd Floor, 110 Norris Canal Road, Colombo 10', hours: 'Mon-Fri: 08:00-15:00', phone: '+94-11-2698500', email: 'info.lka@vfsglobal.com' }
                ],
                docs: [
                    'Valid passport (minimum 6 months validity)',
                    'Completed online application form',
                    'Two passport-size photographs (35x45mm)',
                    'Proof of travel/accommodation in Ireland',
                    'Proof of sufficient funds (€65/day)',
                    'Travel medical insurance (€30,000 coverage)',
                    'Employment/study documents',
                    'Previous visa copies (if any)',
                    'Police clearance certificate (if required)'
                ],
                processing: '15-20 working days',
                fee: '€60 + VFS service charge ₹1,500'
            },
            'beijing': {
                flag: '🇨🇳',
                name: 'Beijing',
                countries: ['China', 'Hong Kong', 'Macau', 'Mongolia'],
                vacs: [
                    { city: 'Beijing', address: 'VFS Global, 1st Floor, Building 1, No. 15 Sanlitun Road, Chaoyang District, Beijing 100027', hours: 'Mon-Fri: 08:00-15:00', phone: '+86-10-85318500', email: 'info.chn@vfsglobal.com' },
                    { city: 'Shanghai', address: 'VFS Global, 2nd Floor, 333 Nanjing West Road, Huangpu District, Shanghai 200003', hours: 'Mon-Fri: 08:00-15:00', phone: '+86-21-63318500', email: 'info.chn@vfsglobal.com' },
                    { city: 'Guangzhou', address: 'VFS Global, 3rd Floor, Tower A, Victory Plaza, 103 Tiyu West Road, Guangzhou 510620', hours: 'Mon-Fri: 08:00-15:00', phone: '+86-20-85318500', email: 'info.chn@vfsglobal.com' },
                    { city: 'Hong Kong', address: 'VFS Global, 8th Floor, One Pacific Place, 88 Queensway, Admiralty, Hong Kong', hours: 'Mon-Fri: 08:00-15:00', phone: '+852-31988500', email: 'info.hkg@vfsglobal.com' },
                    { city: 'Ulaanbaatar', address: 'VFS Global, 2nd Floor, Central Tower, Sukhbaatar Square, Ulaanbaatar', hours: 'Mon-Fri: 09:00-15:00', phone: '+976-70118500', email: 'info.mng@vfsglobal.com' }
                ],
                docs: [
                    'Valid passport (minimum 6 months validity)',
                    'Completed online application form',
                    'Two passport-size photographs (48x33mm for China)',
                    'Proof of travel/accommodation in Ireland',
                    'Proof of sufficient funds',
                    'Travel medical insurance',
                    'Employment/study documents',
                    'Household register (Hukou) copy',
                    'Previous visa copies'
                ],
                processing: '15-25 working days',
                fee: '€60 + VFS service charge ¥350'
            },
            'dublin': {
                flag: '🇮🇪',
                name: 'Dublin Visa Office',
                countries: ['Pakistan', 'Transfers from all offices'],
                vacs: [
                    { city: 'Dublin (INIS)', address: 'Irish Naturalisation and Immigration Service, 13-14 Burgh Quay, Dublin 2, D02 XK70', hours: 'Mon-Fri: 09:30-16:00 (by appointment)', phone: '+353-1-6167700', email: 'info@inis.gov.ie' },
                    { city: 'Islamabad (VFS)', address: 'VFS Global, 1st Floor, Evacuee Trust Complex, Sector F-5/1, Islamabad', hours: 'Mon-Fri: 08:00-15:00', phone: '+92-51-8448500', email: 'info.pak@vfsglobal.com' },
                    { city: 'Karachi (VFS)', address: 'VFS Global, 2nd Floor, The Forum, G-20 Block 9, Clifton, Karachi', hours: 'Mon-Fri: 08:00-15:00', phone: '+92-21-35858500', email: 'info.pak@vfsglobal.com' },
                    { city: 'Lahore (VFS)', address: 'VFS Global, 1st Floor, 35-E/1 Main Boulevard, Gulberg III, Lahore', hours: 'Mon-Fri: 08:00-15:00', phone: '+92-42-35858500', email: 'info.pak@vfsglobal.com' }
                ],
                docs: [
                    'Valid passport',
                    'Completed application form',
                    'Passport photographs',
                    'Supporting documents per visa type',
                    'Fee payment proof'
                ],
                processing: '8-12 weeks (Pakistan), varies for transfers',
                fee: '€60 + VFS service charge'
            },
            'abu-dhabi': {
                flag: '🇦🇪',
                name: 'Abu Dhabi',
                countries: ['UAE', 'Afghanistan', 'Algeria', 'Bahrain', 'Jordan', 'Kuwait', 'Lebanon', 'Libya', 'Morocco', 'Oman', 'Qatar', 'Sudan', 'Syria', 'Tunisia'],
                vacs: [
                    { city: 'Abu Dhabi', address: 'VFS Global, 3rd Floor, Al Falah Tower, Al Falah Street, Abu Dhabi', hours: 'Mon-Fri: 08:00-15:00', phone: '+971-2-6448500', email: 'info.are@vfsglobal.com' },
                    { city: 'Dubai', address: 'VFS Global, 2nd Floor, Al Rostamani Tower, Sheikh Zayed Road, Dubai', hours: 'Mon-Fri: 08:00-15:00', phone: '+971-4-3858500', email: 'info.are@vfsglobal.com' },
                    { city: 'Sharjah', address: 'VFS Global, 1st Floor, Al Zahia City Center, Sharjah', hours: 'Mon-Fri: 08:00-15:00', phone: '+971-6-5458500', email: 'info.are@vfsglobal.com' }
                ],
                docs: [
                    'Valid passport (6 months validity)',
                    'Completed application form',
                    'Passport photographs (white background)',
                    'UAE residence visa copy',
                    'Emirates ID copy',
                    'Proof of travel/accommodation',
                    'Bank statements (3 months)',
                    'Travel insurance',
                    'No objection certificate from employer'
                ],
                processing: '15-20 working days',
                fee: '€60 + VFS service charge AED 250'
            },
            'abuja': {
                flag: '🇳🇬',
                name: 'Abuja',
                countries: ['Nigeria', 'Ghana', 'Côte d\'Ivoire', 'Senegal'],
                vacs: [
                    { city: 'Abuja', address: 'VFS Global, 2nd Floor, Nicon Luxury Hotel, Plot 903, Central Business District, Abuja', hours: 'Mon-Fri: 08:00-15:00', phone: '+234-9-4618500', email: 'info.nga@vfsglobal.com' },
                    { city: 'Lagos', address: 'VFS Global, 4th Floor, Union Bank Building, 14/16 Ahmadu Bello Way, Victoria Island, Lagos', hours: 'Mon-Fri: 08:00-15:00', phone: '+234-1-4618500', email: 'info.nga@vfsglobal.com' },
                    { city: 'Accra (Ghana)', address: 'VFS Global, 3rd Floor, Ghana Commercial Bank Building, High Street, Accra', hours: 'Mon-Fri: 08:00-15:00', phone: '+233-30-2785850', email: 'info.gha@vfsglobal.com' },
                    { city: 'Abidjan (Côte d\'Ivoire)', address: 'VFS Global, 2nd Floor, Immeuble SCIAM, Plateau, Abidjan', hours: 'Mon-Fri: 08:00-15:00', phone: '+225-27-2785850', email: 'info.civ@vfsglobal.com' },
                    { city: 'Dakar (Senegal)', address: 'VFS Global, 3rd Floor, Immeuble Keur Khadija, Place de l\'Indépendance, Dakar', hours: 'Mon-Fri: 08:00-15:00', phone: '+221-33-8898500', email: 'info.sen@vfsglobal.com' }
                ],
                docs: [
                    'Valid passport (6 months validity)',
                    'Completed application form',
                    'Passport photographs',
                    'Proof of legal residence',
                    'Bank statements (6 months)',
                    'Employment letter/payslips',
                    'Travel itinerary & accommodation',
                    'Travel insurance (€30,000)',
                    'Police clearance certificate'
                ],
                processing: '20-30 working days',
                fee: '€60 + VFS service charge ₦25,000'
            },
            'ankara': {
                flag: '🇹🇷',
                name: 'Ankara',
                countries: ['Türkiye', 'Azerbaijan', 'Saudi Arabia residents'],
                vacs: [
                    { city: 'Ankara', address: 'VFS Global, 3rd Floor, Akay Building, Cinnah Caddesi No:19, Kavaklidere, Çankaya, Ankara', hours: 'Mon-Fri: 08:00-15:00', phone: '+90-312-4688500', email: 'info.tur@vfsglobal.com' },
                    { city: 'Istanbul', address: 'VFS Global, 2nd Floor, Emaar Square, Sultan Orhan Gazi Mahallesi, Alemdar Caddesi, Üsküdar, Istanbul', hours: 'Mon-Fri: 08:00-15:00', phone: '+90-212-4688500', email: 'info.tur@vfsglobal.com' },
                    { city: 'Izmir', address: 'VFS Global, 1st Floor, Ege Perla, Mithatpaşa Caddesi, Konak, Izmir', hours: 'Mon-Fri: 08:00-15:00', phone: '+90-232-4688500', email: 'info.tur@vfsglobal.com' },
                    { city: 'Baku (Azerbaijan)', address: 'VFS Global, 2nd Floor, Hyatt Regency Hotel, 1033 Izmir Street, Baku', hours: 'Mon-Fri: 09:00-15:00', phone: '+994-12-4688500', email: 'info.aze@vfsglobal.com' },
                    { city: 'Riyadh (Saudi Arabia)', address: 'VFS Global, 2nd Floor, Olaya Towers, King Fahd Road, Riyadh', hours: 'Sun-Thu: 08:00-15:00', phone: '+966-11-4688500', email: 'info.sau@vfsglobal.com' }
                ],
                docs: [
                    'Valid passport (6 months validity)',
                    'Completed application form',
                    'Biometric photographs',
                    'Residence permit (Ikamet) copy',
                    'Turkish ID card copy',
                    'Bank statements (3 months)',
                    'Employment letter (SSK/SGK)',
                    'Travel insurance',
                    'Hotel/flight booking'
                ],
                processing: '15-25 working days',
                fee: '€60 + VFS service charge ₺1,200'
            }
        };
        
        const tabs = [
            ['overview', 'Overview'],
            ['new-delhi', 'New Delhi'],
            ['beijing', 'Beijing'],
            ['dublin', 'Dublin'],
            ['abu-dhabi', 'Abu Dhabi'],
            ['abuja', 'Abuja'],
            ['ankara', 'Ankara'],
            ['transit', 'Transit Visas'],
        ];
        
        let activeTab = 'overview';
        
        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
        
        function renderOverview() {
            return `
                <div class="card" style="grid-column:1/-1;">
                    <h2 style="margin-top:0;">Visa Application Centres (VACs) for Irish Visas</h2>
                    <p class="note2">Ireland uses VFS Global to operate Visa Application Centres worldwide. You must submit your application at the VAC designated for your country of residence.</p>
                </div>
                <div class="cards">
                    <div class="card"><div class="label"><i data-lucide="map-pin"></i>Total VACs Worldwide</div><div class="value">140+</div></div>
                    <div class="card"><div class="label"><i data-lucide="users"></i>Countries Served</div><div class="value">130+</div></div>
                    <div class="card"><div class="label"><i data-lucide="clock"></i>Processing Time</div><div class="value">Varies by country</div></div>
                    <div class="card"><div class="label"><i data-lucide="credit-card"></i>Service Fee</div><div class="value">€25–€60 + visa fee</div></div>
                </div>
                <div class="note" style="margin-top:16px;">
                    <strong>Key Points:</strong>
                    <ul style="margin:8px 0 0; padding-left:18px;">
                        <li>Biometrics (fingerprints + photo) are required for all applicants aged 6+</li>
                        <li>Appointments must be booked online via <a href="https://www.vfsglobal.com/" target="_blank">VFS Global</a></li>
                        <li>Passport submission is required at the VAC</li>
                        <li>Track your application online using the reference number</li>
                    </ul>
                </div>
            `;
        }
        
        function renderEmbassyTab(slug) {
            const data = embassyData[slug];
            if (!data) return '<div class="empty">No data available.</div>';
            
            return `
                <div class="card" style="grid-column:1/-1;">
                    <h2 style="margin-top:0;">${data.flag} ${data.name} - Visa Application Centres</h2>
                    <p class="note2">Countries served: ${data.countries.join(', ')}</p>
                </div>
                <div class="card" style="grid-column:1/-1;">
                    <h3><i data-lucide="building"></i> VAC Locations</h3>
                    ${data.vacs.map(v => `
                        <div class="vac-item">
                            <div class="vac-name"><i data-lucide="map-pin"></i> ${v.city}</div>
                            <div class="vac-address">${v.address}</div>
                            <div class="vac-hours"><i data-lucide="clock"></i> ${v.hours}</div>
                            <div class="vac-contact"><i data-lucide="phone"></i> ${v.phone} | <i data-lucide="mail"></i> ${v.email}</div>
                        </div>
                    `).join('')}
                </div>
                <div class="cards">
                    <div class="card"><div class="label"><i data-lucide="file-text"></i> Documents Required</div><div class="value">${data.docs.length} items</div></div>
                    <div class="card"><div class="label"><i data-lucide="clock"></i> Avg Processing</div><div class="value">${data.processing}</div></div>
                    <div class="card"><div class="label"><i data-lucide="credit-card"></i> Service Fee</div><div class="value">${data.fee}</div></div>
                </div>
                <div class="card" style="grid-column:1/-1;">
                    <h3><i data-lucide="file-text"></i> Required Documents</h3>
                    <ul style="margin:0; padding-left:18px;">
                        ${data.docs.map(d => `<li>${d}</li>`).join('')}
                    </ul>
                </div>
            `;
        }
        
        function renderTransit() {
            return `
                <div class="card" style="grid-column:1/-1;">
                    <h2 style="margin-top:0;"><i data-lucide="plane"></i> Irish Transit Visa Requirements</h2>
                    <p class="note2">Check if you need a transit visa when connecting through Irish airports.</p>
                </div>
                <div class="card" style="grid-column:1/-1;">
                    <h3><i data-lucide="shield-check"></i> Who Needs a Transit Visa?</h3>
                    <p>You need an Irish transit visa if you are a citizen of the following countries and are transiting through an Irish airport:</p>
                    <div class="note" style="background:#fef3c7; border-color:#fcd34d; color:#92400e;">
                        Afghanistan, Albania, Algeria, Angola, Bangladesh, Belarus, Burma/Myanmar, Burundi, Cameroon, Central African Republic, Chad, China, Colombia, Congo (DRC), Congo (Republic), Cuba, Djibouti, Dominican Republic, Egypt, Equatorial Guinea, Eritrea, Ethiopia, Gambia, Georgia, Ghana, Guinea, Guinea-Bissau, Haiti, India, Iran, Iraq, Ivory Coast, Jamaica, Jordan, Kazakhstan, Kenya, Kosovo, Kyrgyzstan, Lebanon, Liberia, Libya, Mali, Moldova, Mongolia, Montenegro, Morocco, Nepal, Nigeria, North Korea, North Macedonia, Pakistan, Palestinian Territory, Peru, Philippines, Russia, Rwanda, Senegal, Serbia, Sierra Leone, Somalia, South Africa, South Sudan, Sri Lanka, Sudan, Syria, Tajikistan, Tanzania, Thailand, Togo, Tunisia, Turkey, Turkmenistan, Uganda, Ukraine, Uzbekistan, Vietnam, Yemen, Zambia, Zimbabwe
                    </div>
                </div>
                <div class="cards">
                    <div class="card"><div class="label"><i data-lucide="shield"></i> Exemptions</div><div class="value">EU/EEA/Swiss citizens, UK residents, valid Schengen/UK/US/Canada visa holders</div></div>
                    <div class="card"><div class="label"><i data-lucide="clock"></i> Max Stay</div><div class="value">24 hours (airside transit)</div></div>
                    <div class="card"><div class="label"><i data-lucide="file-text"></i> Visa Type</div><div class="value">Transit Visa (single/double entry)</div></div>
                    <div class="card"><div class="label"><i data-lucide="credit-card"></i> Fee</div><div class="value">€25</div></div>
                </div>
                <div class="card" style="grid-column:1/-1;">
                    <h3><i data-lucide="info"></i> Important Notes</h3>
                    <ul style="margin:0; padding-left:18px;">
                        <li>Airside transit (not leaving the airport) still requires a transit visa for listed nationalities</li>
                        <li>If you leave the airport (landside), you need a regular short-stay 'C' visa</li>
                        <li>Transit visa does not permit entry into Ireland for tourism/business</li>
                        <li>Apply at the VAC for your country of residence, not the transit country</li>
                    </ul>
                </div>
            `;
        }
        
        function switchTab(tabId) {
            activeTab = tabId;
            const tabBody = document.getElementById('tab-body');
            if (!tabBody) return;
            
            let html = '';
            if (tabId === 'overview') html = renderOverview();
            else if (tabId === 'transit') html = renderTransit();
            else html = renderEmbassyTab(tabId);
            
            tabBody.setAttribute('aria-labelledby', 'tab-' + tabId);
            tabBody.innerHTML = html;
            
            // Update active pill
            document.querySelectorAll('.navpill').forEach(p => {
                const selected = p.dataset.tab === tabId;
                p.classList.toggle('active', selected);
                p.setAttribute('aria-selected', selected ? 'true' : 'false');
                p.tabIndex = selected ? 0 : -1;
            });
            
            if (window.lucide) lucide.createIcons({ nameAttr: 'data-lucide', attrs: { 'aria-hidden': 'true' } });
        }
        
        // Event listeners
        document.querySelectorAll('.navpill').forEach(pill => {
            pill.addEventListener('click', () => switchTab(pill.dataset.tab));
        });

        document.querySelectorAll('.navpill').forEach(function (pill, index, all) {
            pill.addEventListener('keydown', function (event) {
                var next = null;
                if (event.key === 'ArrowRight') next = (index + 1) % all.length;
                else if (event.key === 'ArrowLeft') next = (index - 1 + all.length) % all.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = all.length - 1;
                if (next === null) return;
                event.preventDefault();
                all[next].focus();
                switchTab(all[next].dataset.tab);
            });
        });
        
        // Initial render
        switchTab('overview');
    })();
